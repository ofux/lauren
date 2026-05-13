import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { LaurenConfig } from './core/config.js';
import { displayPath } from './core/paths.js';
import type { PlanStore } from './core/store.js';
import { nowIso } from './core/time.js';
import {
  ImplementingLocked,
  type Plan,
  type PlanFailure,
  type PlanMergeBlock,
  PlanNotFound,
  type PlanWorktree,
  planFilePath,
  planLogDir,
} from './core/types.js';
import { ghPrCreate, ghPrView } from './proc/gh.js';
import {
  getCurrentBranch,
  gitAddPaths,
  gitBranchHasDiff,
  gitCheckout,
  gitFastForward,
  gitFetchBranch,
  gitMerge,
  gitMergeAbort,
  gitMergeContinue,
  gitPush,
  hasUnresolvedMergeConflicts,
  listUnresolvedConflicts,
  parseDirtyMergeRefusal,
} from './proc/git.js';
import { streamSubprocess } from './proc/stream.js';
import { formatClaudeStreamLine } from './util/streamJson.js';
import { cleanupPlanWorktrees } from './worktree.js';

export type MergeResult =
  | { kind: 'done' }
  | { kind: 'cancelled' }
  | { kind: 'aborted' }
  | { kind: 'failed'; failure: PlanFailure }
  | { kind: 'pending' }
  | { kind: 'cleanup_failed'; failure: PlanFailure }
  /**
   * Git refused to merge / checkout / fast-forward because uncommitted
   * changes in the parent checkout overlap with the operation. The
   * watcher transitions the row to 'merge_blocked', stamps the
   * {@link PlanMergeBlock} (including the specific files git named), and
   * polls until those files are clean — at which point the row is
   * promoted back to 'merging' and the merge retries from the top.
   * Unrelated WIP in other files does NOT trigger this pause: git only
   * refuses on actual overlap.
   */
  | { kind: 'paused'; block: PlanMergeBlock };

export const PR_POLL_INTERVAL_MS = 30_000;

function planTitleSubject(plan: Plan): string {
  return `${plan.slug}: ${plan.title}`;
}

function buildPrBody(plan: Plan, planMarkdown: string): string {
  return `Plan: \`${plan.slug}\`\n\n${planMarkdown}`;
}

function failure(message: string): PlanFailure {
  return { phase: 'merge', step_id: null, message };
}

/**
 * Build a {@link PlanMergeBlock} from a git "would be overwritten" refusal.
 * Returns null if `stderr` doesn't match the pattern — caller treats it as
 * an ordinary failure. Otherwise the block carries the exact files git
 * named so {@link PlanMergeBlock.files} can drive a precise auto-resume
 * (only the *named* files matter; unrelated WIP elsewhere doesn't block).
 */
function dirtyRefusalBlock(args: {
  stderr: string;
  reason: PlanMergeBlock['reason'];
  repo: string | null;
  parentRoot: string;
  action: 'merge' | 'checkout' | 'fast-forward';
}): PlanMergeBlock | null {
  const parsed = parseDirtyMergeRefusal(args.stderr);
  if (!parsed) return null;
  const actionPhrase =
    args.action === 'merge'
      ? 'resume the merge'
      : args.action === 'checkout'
        ? `switch the parent checkout to merge`
        : 'fast-forward the merged PR';
  const preview = parsed.files.slice(0, 3).join(', ') + (parsed.files.length > 3 ? ', …' : '');
  return {
    reason: args.reason,
    repo: args.repo,
    parent_root: args.parentRoot,
    files: parsed.files,
    detected_at: nowIso(),
    message:
      `${displayPath(args.parentRoot)}: git refused — these files have uncommitted ` +
      `changes that would be overwritten (${preview}). Commit/stash them to ${actionPhrase}.`,
  };
}

function cleanupFailure(err: unknown, cleanupResult: 'done' | 'cancelled'): PlanFailure {
  const msg = err instanceof Error ? err.message : String(err);
  const context = cleanupResult === 'cancelled' ? 'PR closed without merging' : 'merge landed';
  return {
    phase: 'cleanup',
    step_id: null,
    message: `${context}, but cleanup failed: ${msg}`,
    cleanup_result: cleanupResult,
  };
}

async function cleanupPlanWorktreesForResult(
  plan: Plan,
  cleanupResult: 'done' | 'cancelled',
): Promise<MergeResult> {
  try {
    await cleanupPlanWorktrees(plan);
  } catch (err) {
    return { kind: 'cleanup_failed', failure: cleanupFailure(err, cleanupResult) };
  }
  return { kind: cleanupResult };
}

async function readPlanMarkdown(plan: Plan): Promise<string> {
  try {
    return await fs.readFile(planFilePath(plan), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Spawn `claude -p` inside the parent repo whose merge conflicted and ask
 * it to resolve the conflicts. The caller commits the result with
 * `git commit --no-edit`.
 */
async function runConflictResolver(args: {
  plan: Plan;
  parentRoot: string;
  branch: string;
  baseBranch: string;
  logPath: string;
  signal?: AbortSignal;
}): Promise<number> {
  const prompt =
    `You are resolving a git merge conflict in ${args.parentRoot}.\n` +
    `The merge of branch \`${args.branch}\` into \`${args.baseBranch}\` ` +
    `produced conflicts.\n\n` +
    `Run \`git status\` to list conflicting files, open each one, ` +
    `pick the correct resolution (combining both sides as needed), and ` +
    `\`git add\` the resolved files. Do NOT run \`git commit\` — the ` +
    `orchestrator will commit once you finish.\n\n` +
    `Stay strictly within conflict resolution. Do not modify unrelated files.`;
  return streamSubprocess({
    cmd: ['claude', '-p', '--output-format', 'stream-json', '--verbose', prompt],
    logPath: args.logPath,
    cwd: args.parentRoot,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
    transformer: formatClaudeStreamLine,
  });
}

/**
 * Auto-merge each worktree's branch into the configured dev_branch in its
 * parent repo. On clean merge: cleanup worktrees + branches, return done.
 * On conflict: launch claude to resolve, then commit. Any unrecoverable
 * error returns `failed` with a message describing what to fix manually.
 *
 * Dirty-tree policy (option A): no upfront pre-flight. We let git decide
 * whether the dirt actually conflicts with the merge. Git refuses cleanly
 * with "Your local changes to the following files would be overwritten"
 * only when the merge would overwrite a dirty file — and leaves the tree
 * untouched. We parse that refusal into a {@link PlanMergeBlock} pause.
 * Unrelated WIP in other files goes through transparently.
 */
async function autoMerge(args: {
  plan: Plan;
  config: LaurenConfig;
  signal?: AbortSignal;
}): Promise<MergeResult> {
  const { plan, config, signal } = args;
  const worktrees = plan.worktrees ?? [];
  if (worktrees.length === 0) {
    return { kind: 'failed', failure: failure('no worktrees recorded on plan row') };
  }

  for (const wt of worktrees) {
    if (signal?.aborted) return { kind: 'aborted' };

    // Parent checkout must be on dev_branch for the merge to land where
    // the user expects. If it's on a different branch and a checkout
    // would overwrite local WIP, git refuses — we parse that into a
    // 'merge_blocked' pause so the user can clean up and we auto-resume.
    // Any other checkout failure is surfaced as 'failed' (something
    // unusual is wrong with the checkout, not just dirt overlap).
    const currentBranch = getCurrentBranch(wt.parentRoot);
    if (currentBranch !== config.dev_branch) {
      try {
        gitCheckout(config.dev_branch, wt.parentRoot);
      } catch (err) {
        const stderr =
          (err as Error & { gitStderr?: string }).gitStderr ??
          (err instanceof Error ? err.message : String(err));
        const block = dirtyRefusalBlock({
          stderr,
          reason: 'dirty-checkout',
          repo: wt.repo,
          parentRoot: wt.parentRoot,
          action: 'checkout',
        });
        if (block) return { kind: 'paused', block };
        const msg = err instanceof Error ? err.message : String(err);
        return {
          kind: 'failed',
          failure: failure(
            `cannot switch ${displayPath(wt.parentRoot)} to '${config.dev_branch}' (currently '${currentBranch}'): ${msg}`,
          ),
        };
      }
    }

    const merge = gitMerge(wt.branch, wt.parentRoot);
    if (merge.code === 0) continue;

    if (!merge.hasConflicts) {
      // Distinguish dirt-overlap (recoverable, pauses) from other merge
      // failures (e.g. refusing to merge unrelated histories — terminal).
      const block = dirtyRefusalBlock({
        stderr: merge.stderr,
        reason: 'dirty-merge',
        repo: wt.repo,
        parentRoot: wt.parentRoot,
        action: 'merge',
      });
      if (block) return { kind: 'paused', block };
      return {
        kind: 'failed',
        failure: failure(
          `git merge ${wt.branch} into ${config.dev_branch} failed in ${displayPath(
            wt.parentRoot,
          )} (exit ${merge.code}): ${merge.stderr.trim().slice(0, 400)}`,
        ),
      };
    }

    // Conflict path: ask claude to resolve, then commit. Capture the
    // exact set of files currently in unmerged state BEFORE claude runs.
    // gitMerge already auto-staged everything it could merge without
    // conflict, so the only files left to stage post-resolution are these.
    // Staging *only* this list keeps any unrelated WIP in the parent
    // checkout (now allowed at merge time by option A) out of the merge
    // commit — a `git add -A` here would silently sweep it in.
    const conflictPaths = listUnresolvedConflicts(wt.parentRoot);

    const conflictLogDir = planLogDir(plan);
    await fs.mkdir(conflictLogDir, { recursive: true });
    const logPath = path.join(conflictLogDir, `merge-${wt.repo ?? 'root'}.log`);
    const claudeCode = await runConflictResolver({
      plan,
      parentRoot: wt.parentRoot,
      branch: wt.branch,
      baseBranch: config.dev_branch,
      logPath,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (claudeCode !== 0) {
      gitMergeAbort(wt.parentRoot);
      if (signal?.aborted) {
        return { kind: 'aborted' };
      }
      return {
        kind: 'failed',
        failure: failure(
          `claude conflict resolver exited ${claudeCode} in ${displayPath(
            wt.parentRoot,
          )}; ran \`git merge --abort\`. See ${displayPath(logPath)}.`,
        ),
      };
    }
    // Claude is instructed to `git add` resolved files itself, but keep the
    // older defensive fallback for successful resolutions it left unstaged.
    // Stage only the paths that were unmerged before Claude ran so unrelated
    // WIP in the parent checkout cannot be swept into the merge commit.
    gitAddPaths(wt.parentRoot, conflictPaths);
    // After the fallback add, any remaining U entries are genuinely still
    // unresolved from git's perspective.
    if (hasUnresolvedMergeConflicts(wt.parentRoot)) {
      gitMergeAbort(wt.parentRoot);
      return {
        kind: 'failed',
        failure: failure(
          `claude finished but ${displayPath(wt.parentRoot)} still has unresolved changes; ` +
            `ran \`git merge --abort\`. See ${displayPath(logPath)}.`,
        ),
      };
    }
    const commit = gitMergeContinue(wt.parentRoot);
    if (commit.code !== 0) {
      gitMergeAbort(wt.parentRoot);
      return {
        kind: 'failed',
        failure: failure(
          `failed to commit conflict resolution in ${displayPath(
            wt.parentRoot,
          )} (exit ${commit.code}): ${commit.stderr.trim().slice(0, 400)}`,
        ),
      };
    }
  }

  return cleanupPlanWorktreesForResult(plan, 'done');
}

function urlKey(wt: PlanWorktree): string {
  return wt.repo ?? '.';
}

/**
 * Open a PR for each worktree (idempotent — skips repos that already have
 * a recorded `pr_urls[repo]`) and persist the URLs on the plan row. On
 * the first call this also pushes the branch.
 */
async function ensurePrsOpen(args: {
  plan: Plan;
  store: PlanStore;
  config: LaurenConfig;
}): Promise<{ updated: Plan } | { failure: PlanFailure }> {
  const { plan, store, config } = args;
  const worktrees = plan.worktrees ?? [];
  if (worktrees.length === 0) {
    return { failure: failure('no worktrees recorded on plan row') };
  }

  const prUrls: Record<string, string> = { ...(plan.pr_urls ?? {}) };
  let updatedPlan = plan;
  const planMarkdown = await readPlanMarkdown(plan);
  const title = planTitleSubject(plan);
  const body = buildPrBody(plan, planMarkdown);

  for (const wt of worktrees) {
    const key = urlKey(wt);
    if (prUrls[key]) continue;
    if (!gitBranchHasDiff({ cwd: wt.path, base: config.dev_branch })) continue;

    const push = gitPush({ cwd: wt.path, branch: wt.branch, setUpstream: true });
    if (push.code !== 0 && !/up-to-date|already exists/i.test(push.stderr)) {
      return {
        failure: failure(
          `git push -u origin ${wt.branch} failed in ${displayPath(wt.path)} (exit ${push.code}): ` +
            push.stderr.trim().slice(0, 400),
        ),
      };
    }
    let url: string;
    try {
      url = ghPrCreate({
        cwd: wt.path,
        base: config.dev_branch,
        head: wt.branch,
        title,
        body,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { failure: failure(`gh pr create failed for ${wt.branch}: ${msg}`) };
    }
    prUrls[key] = url;
    try {
      updatedPlan = await store.update(
        plan.slug,
        { pr_urls: { ...prUrls } },
        { allowMerging: true },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { failure: failure(`failed to persist PR URL for ${wt.branch}: ${msg}`) };
    }
  }

  return { updated: updatedPlan };
}

/**
 * Inspect each PR's current state. Returns the aggregate result:
 *   - all merged → done
 *   - any closed without merge → cancelled (cleanup branches/worktrees)
 *   - else → pending
 */
function checkPrs(
  plan: Plan,
  config: LaurenConfig,
): { kind: 'done' } | { kind: 'cancelled' } | { kind: 'pending' } {
  const worktrees = plan.worktrees ?? [];
  const urls = plan.pr_urls ?? {};
  let allMerged = true;
  for (const wt of worktrees) {
    const url = urls[urlKey(wt)];
    if (!url) {
      if (!gitBranchHasDiff({ cwd: wt.path, base: config.dev_branch })) continue;
      allMerged = false;
      continue;
    }
    const status = ghPrView(url, wt.path);
    if (status.state === 'CLOSED' && !status.merged) {
      return { kind: 'cancelled' };
    }
    if (!status.merged) allMerged = false;
  }
  return allMerged ? { kind: 'done' } : { kind: 'pending' };
}

function uniqueParentWorktrees(worktrees: readonly PlanWorktree[]): PlanWorktree[] {
  const seen = new Set<string>();
  const unique: PlanWorktree[] = [];
  for (const wt of worktrees) {
    if (seen.has(wt.parentRoot)) continue;
    seen.add(wt.parentRoot);
    unique.push(wt);
  }
  return unique;
}

type FastForwardOutcome =
  | { kind: 'done' }
  | { kind: 'paused'; block: PlanMergeBlock }
  | { kind: 'failed'; failure: PlanFailure };

function fastForwardPrMergeTargets(plan: Plan, config: LaurenConfig): FastForwardOutcome {
  const worktrees = plan.worktrees ?? [];
  const parentWorktrees = uniqueParentWorktrees(worktrees);

  for (const wt of parentWorktrees) {
    const fetch = gitFetchBranch({ cwd: wt.parentRoot, branch: config.dev_branch });
    if (fetch.code !== 0) {
      return {
        kind: 'failed',
        failure: failure(
          `git fetch origin ${config.dev_branch} failed in ${displayPath(wt.parentRoot)} ` +
            `(exit ${fetch.code}): ${fetch.stderr.trim().slice(0, 400)}`,
        ),
      };
    }

    const currentBranch = getCurrentBranch(wt.parentRoot);
    if (currentBranch !== config.dev_branch) {
      try {
        gitCheckout(config.dev_branch, wt.parentRoot);
      } catch (err) {
        const stderr =
          (err as Error & { gitStderr?: string }).gitStderr ??
          (err instanceof Error ? err.message : String(err));
        const block = dirtyRefusalBlock({
          stderr,
          reason: 'dirty-fast-forward',
          repo: wt.repo,
          parentRoot: wt.parentRoot,
          action: 'checkout',
        });
        if (block) return { kind: 'paused', block };
        const msg = err instanceof Error ? err.message : String(err);
        return {
          kind: 'failed',
          failure: failure(
            `cannot switch ${displayPath(wt.parentRoot)} to '${config.dev_branch}' ` +
              `(currently '${currentBranch}') before fast-forwarding merged PR: ${msg}`,
          ),
        };
      }
    }

    const ff = gitFastForward('FETCH_HEAD', wt.parentRoot);
    if (ff.code !== 0) {
      const block = dirtyRefusalBlock({
        stderr: ff.stderr,
        reason: 'dirty-fast-forward',
        repo: wt.repo,
        parentRoot: wt.parentRoot,
        action: 'fast-forward',
      });
      if (block) return { kind: 'paused', block };
      return {
        kind: 'failed',
        failure: failure(
          `git merge --ff-only FETCH_HEAD failed in ${displayPath(wt.parentRoot)} ` +
            `(exit ${ff.code}): ${ff.stderr.trim().slice(0, 400)}`,
        ),
      };
    }
  }
  return { kind: 'done' };
}

/**
 * Single attempt at draining a `merging` row. Caller polls every
 * {@link PR_POLL_INTERVAL_MS} ms for github-pr mode; auto-merge is always
 * terminal in one call.
 */
export async function mergePlanOnce(args: {
  plan: Plan;
  store: PlanStore;
  config: LaurenConfig;
  signal?: AbortSignal;
}): Promise<MergeResult> {
  const { plan, store, config, signal } = args;
  if (signal?.aborted) return { kind: 'aborted' };

  if (plan.failure?.phase === 'cleanup') {
    return cleanupPlanWorktreesForResult(plan, plan.failure.cleanup_result ?? 'done');
  }

  if (config.merge_mode === 'auto') {
    return autoMerge({ plan, config, ...(signal !== undefined ? { signal } : {}) });
  }

  // github-pr mode
  const opened = await ensurePrsOpen({ plan, store, config });
  if ('failure' in opened) return { kind: 'failed', failure: opened.failure };

  let result: { kind: 'done' } | { kind: 'cancelled' } | { kind: 'pending' };
  try {
    result = checkPrs(opened.updated, config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'failed', failure: failure(`gh pr view failed: ${msg}`) };
  }
  if (result.kind === 'done') {
    const ff = fastForwardPrMergeTargets(opened.updated, config);
    if (ff.kind === 'failed') return { kind: 'failed', failure: ff.failure };
    if (ff.kind === 'paused') return { kind: 'paused', block: ff.block };
    return cleanupPlanWorktreesForResult(opened.updated, 'done');
  }
  if (result.kind === 'cancelled') {
    // PR was closed without merging — surface as cancelled and clean up.
    return cleanupPlanWorktreesForResult(opened.updated, 'cancelled');
  }
  return { kind: 'pending' };
}

/**
 * Apply a terminal merge result to the store, swallowing locking races
 * that can occur if the daemon is shutting down concurrently.
 */
export async function finalizeMerge(
  store: PlanStore,
  slug: string,
  result: Exclude<
    MergeResult,
    { kind: 'pending' } | { kind: 'cleanup_failed' } | { kind: 'aborted' } | { kind: 'paused' }
  >,
): Promise<void> {
  const fields: Partial<Plan> =
    result.kind === 'done'
      ? {
          status: 'done',
          finished_at: nowIso(),
          failure: null,
          cancel_requested: false,
          cancel_intent: undefined,
          pr_urls: undefined,
          worktrees: undefined,
        }
      : result.kind === 'cancelled'
        ? {
            status: 'cancelled',
            finished_at: nowIso(),
            failure: null,
            cancel_requested: false,
            cancel_intent: undefined,
            pr_urls: undefined,
            worktrees: undefined,
          }
        : {
            status: 'failed',
            failure: result.failure,
            finished_at: nowIso(),
          };
  try {
    await store.update(slug, fields, { allowMerging: true, allowImplementing: true });
  } catch (err) {
    if (!(err instanceof ImplementingLocked) && !(err instanceof PlanNotFound)) throw err;
  }
}
