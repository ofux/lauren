import { promises as fs } from 'node:fs';
import path from 'node:path';

import { displayPath, REPO } from './core/paths.js';
import type { PR, PrEntry } from './core/prs.js';
import { type Plan, planFilePath, planLogDir } from './core/types.js';
import {
  type ResolvedWorkspaceRepo,
  resolveWorkspaceRepos,
  WorkspaceConfigError,
} from './core/workspace.js';
import {
  fixPlanPrompt,
  fixPrompt,
  implementPlanPrompt,
  implementPrompt,
  planCommitMessage,
  prCommitMessage,
  reviewPlanPrompt,
  reviewPrompt,
} from './executor-prompts.js';
import { runCodexReview } from './proc/codex.js';
import { type GitCommitResult, gitAddAll, gitCommit, workingTreeDirty } from './proc/git.js';
import { streamSubprocess } from './proc/stream.js';
import { formatClaudeStreamLine } from './util/streamJson.js';

export type StepName = 'implement' | 'review' | 'fix' | 'commit';
export type StepStatus = 'done' | 'failed' | 'skipped';
export type ItemStatus = 'done' | 'failed';

export const PR_STEPS: readonly StepName[] = ['implement', 'review', 'fix', 'commit'] as const;

export class RunFailure extends Error {
  readonly step: StepName | 'unknown';
  readonly prId: string | null;
  /** The original message, without the `${step}: ` prefix added to Error.message. */
  readonly rawMessage: string;
  constructor(step: StepName | 'unknown', message: string, prId: string | null = null) {
    super(`${step}: ${message}`);
    this.name = 'RunFailure';
    this.step = step;
    this.prId = prId;
    this.rawMessage = message;
  }
}

/**
 * Sink that observes runner progress. Implementations: a TUI bridge in
 * vibe-command.ts, or undefined (the runner falls back to plain stdout banners).
 */
export interface ProgressSink {
  appendLog(line: string): void;
  beginItem(itemId: string): void;
  endItem(itemId: string, status: ItemStatus): void;
  markItemDone(itemId: string): void;
  beginStep(itemId: string, step: StepName, label: string): void;
  endStep(itemId: string, step: StepName, status: StepStatus): void;
}

function prLogDir(parentLogDir: string, pr: PR): string {
  return path.join(parentLogDir, `PR-${pr.id}`);
}

function banner(text: string): void {
  const bar = '═'.repeat(Math.max(60, text.length + 4));
  process.stdout.write(`\n${bar}\n  ${text}\n${bar}\n`);
}

export interface RunPrOptions {
  pr: PR;
  plan: Plan;
  planPath: string;
  parentLogDir: string;
  targetRepos: readonly ResolvedWorkspaceRepo[];
  dryRun: boolean;
  progress?: ProgressSink;
  signal?: AbortSignal;
}

export interface RunPlanSingleUnitOptions {
  plan: Plan;
  planText: string;
  parentLogDir: string;
  targetRepos: readonly ResolvedWorkspaceRepo[];
  dryRun: boolean;
  progress?: ProgressSink;
  signal?: AbortSignal;
}

interface ExecutionUnit {
  itemId: string;
  prId: string | null;
  slug: string;
  banner: string;
  implementConsole: string;
  reviewConsole: string;
  fixConsole: string;
  commitConsole: string;
  implementLabel: string;
  reviewLabel: string;
  fixLabel: string;
  commitLabel: string;
  implementPrompt: string;
  reviewPrompt: string;
  fixPrompt: (reviewText: string) => string;
  commitMessage: string;
  logDir: string;
  dryRunImplementArgs?: string[];
}

function dirtyRepos(repos: readonly ResolvedWorkspaceRepo[]): ResolvedWorkspaceRepo[] {
  return repos.filter((repo) => workingTreeDirty(repo.root));
}

function formatRepos(repos: readonly ResolvedWorkspaceRepo[]): string {
  return repos.map((repo) => `${repo.name} (${repo.path})`).join(', ');
}

function claudePrintCommand(prompt: string): string[] {
  return ['claude', '-p', '--output-format', 'stream-json', '--verbose', prompt];
}

function lastNonEmptyLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 ? (lines[lines.length - 1] ?? '') : '';
}

function commitGitTail(commit: { stdout?: string; stderr?: string }): string {
  return lastNonEmptyLine((commit.stderr ?? '') + (commit.stdout ?? ''));
}

/**
 * Human-readable message stored on `failure.message` (and surfaced in the TUI's
 * paused panel) when one of the per-repo commits fails mid-multi-repo. The
 * message has to stand on its own — there's no separate "what to do" UI — so it
 * names the repo, quotes the exact commit subject, and tells the user how to
 * resume after committing manually. Exported for unit testing.
 */
export function formatCommitFailureMessage(args: {
  repoName: string;
  repoPath: string;
  commitSubject: string;
  slug: string;
  exitCode: number;
  gitTail: string;
}): string {
  const { repoName, repoPath, commitSubject, slug, exitCode, gitTail } = args;
  const tailPart = gitTail.length > 0 ? `: ${gitTail}` : '';
  return [
    `failed to commit changes in repo '${repoName}' (${repoPath}). ` +
      `git exited ${exitCode}${tailPart}`,
    'Pausing vibe until you fix it. Inspect the staged changes, address the error,',
    'then commit manually with this subject (so resume detects it):',
    `  ${commitSubject}`,
    `Then run \`lauren vibe retry ${slug}\` (or restart \`lauren vibe\`).`,
  ].join('\n');
}

/**
 * Stage and commit each dirty target repo with the same subject. Only repos
 * that actually have changes get a commit — we never create empty marker
 * commits in peer repos.
 *
 * Partial-failure recovery: if commit succeeds in repo A and then fails in
 * repo B, A's commit is permanent (we don't rewrite history). The caller
 * throws RunFailure with a message that names B and quotes the exact commit
 * subject; the watcher pauses and the user fixes B manually using that
 * subject. The PR row is marked `failed` in the todo store, so on
 * `lauren vibe retry <slug>` the PR re-runs — pick scopes that minimize
 * cross-repo coupling so manual recovery + retry doesn't fight a duplicate
 * commit in repo A.
 */
function commitAllTargetRepos(
  dirtyTargets: readonly ResolvedWorkspaceRepo[],
  message: string,
  progress?: ProgressSink,
): { repo: ResolvedWorkspaceRepo; commit: GitCommitResult } | null {
  for (const repo of dirtyTargets) {
    gitAddAll(repo.root);
    const commit = gitCommit(message, {
      capture: progress !== undefined,
      cwd: repo.root,
    });
    if (commit.code !== 0) {
      return { repo, commit };
    }
  }
  return null;
}

/**
 * Outcome of a single execution unit. `alreadyDone` is true when the implement
 * step exited cleanly but produced no diff — we treat that as "the work was
 * already there" and skip review/fix/commit. The caller uses this to decide
 * whether to record a `commit_subject` on the PR row.
 */
export interface ExecutionUnitResult {
  alreadyDone: boolean;
}

async function runExecutionUnit(args: {
  unit: ExecutionUnit;
  targetRepos: readonly ResolvedWorkspaceRepo[];
  dryRun: boolean;
  progress?: ProgressSink;
  signal?: AbortSignal;
}): Promise<ExecutionUnitResult> {
  const { unit, targetRepos, dryRun, progress, signal } = args;
  await fs.mkdir(unit.logDir, { recursive: true });
  if (!progress) banner(unit.banner);

  const dirtyBeforeStart = dirtyRepos(targetRepos);
  if (dirtyBeforeStart.length > 0) {
    throw new RunFailure(
      'implement',
      `target repo(s) are dirty before starting: ${formatRepos(
        dirtyBeforeStart,
      )}; commit or stash changes first.`,
      unit.prId,
    );
  }

  const implementCmd = claudePrintCommand(unit.implementPrompt);
  if (progress) {
    progress.beginStep(unit.itemId, 'implement', unit.implementLabel);
  } else {
    process.stdout.write(`\n→ [1/4] ${unit.implementConsole}\n`);
  }
  if (dryRun) {
    const displayArgs = unit.dryRunImplementArgs ?? implementCmd;
    process.stdout.write(`  (dry-run) ${displayArgs.map((a) => JSON.stringify(a)).join(' ')}\n`);
  } else {
    const sinkArg = progress ?? undefined;
    const logPath = path.join(unit.logDir, '1-implement.log');
    const rc = await streamSubprocess({
      cmd: implementCmd,
      logPath,
      ...(sinkArg !== undefined ? { sink: sinkArg } : {}),
      ...(signal !== undefined ? { signal } : {}),
      transformer: formatClaudeStreamLine,
    });
    if (rc !== 0) {
      progress?.endStep(unit.itemId, 'implement', 'failed');
      throw new RunFailure('implement', `claude exited ${rc}`, unit.prId);
    }
    progress?.endStep(unit.itemId, 'implement', 'done');
    if (dirtyRepos(targetRepos).length === 0) {
      const note =
        'no changes after implement — assuming work was already done; ' +
        'skipping review/fix/commit';
      if (progress) {
        progress.appendLog(`(${note})`);
        progress.endStep(unit.itemId, 'review', 'skipped');
        progress.endStep(unit.itemId, 'fix', 'skipped');
        progress.endStep(unit.itemId, 'commit', 'skipped');
      } else {
        process.stdout.write(`  ${note} (see ${displayPath(logPath)})\n`);
      }
      return { alreadyDone: true };
    }
  }

  const reviewMessagePath = path.join(unit.logDir, '2-review.message.txt');
  if (progress) {
    progress.beginStep(unit.itemId, 'review', unit.reviewLabel);
  } else {
    process.stdout.write(`\n→ [2/4] ${unit.reviewConsole}\n`);
  }
  let reviewText = '';
  if (dryRun) {
    process.stdout.write(`  (dry-run) codex exec review -o ${reviewMessagePath} <review-prompt>\n`);
  } else {
    const sinkArg = progress ?? undefined;
    const { code, reviewText: text } = await runCodexReview({
      prompt: unit.reviewPrompt,
      outputPath: reviewMessagePath,
      logPath: path.join(unit.logDir, '2-review.log'),
      ...(sinkArg !== undefined ? { sink: sinkArg } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (code !== 0) {
      progress?.endStep(unit.itemId, 'review', 'failed');
      throw new RunFailure('review', `codex exited ${code}`, unit.prId);
    }
    reviewText = text;
    if (progress) {
      progress.endStep(unit.itemId, 'review', 'done');
    } else if (reviewText.trim().length === 0) {
      process.stdout.write('  (warning) codex returned an empty review; skipping fix step.\n');
    }
  }

  if (dryRun) {
    process.stdout.write(`\n→ [3/4] (dry-run) ${unit.fixConsole}\n`);
  } else if (reviewText.trim().length > 0) {
    const fixCmd = claudePrintCommand(unit.fixPrompt(reviewText));
    if (progress) {
      progress.beginStep(unit.itemId, 'fix', unit.fixLabel);
    } else {
      process.stdout.write(`\n→ [3/4] ${unit.fixConsole}\n`);
    }
    const sinkArg = progress ?? undefined;
    const rc = await streamSubprocess({
      cmd: fixCmd,
      logPath: path.join(unit.logDir, '3-fix.log'),
      ...(sinkArg !== undefined ? { sink: sinkArg } : {}),
      ...(signal !== undefined ? { signal } : {}),
      transformer: formatClaudeStreamLine,
    });
    if (rc !== 0) {
      progress?.endStep(unit.itemId, 'fix', 'failed');
      throw new RunFailure('fix', `claude exited ${rc}`, unit.prId);
    }
    progress?.endStep(unit.itemId, 'fix', 'done');
  } else {
    progress?.endStep(unit.itemId, 'fix', 'skipped');
  }

  if (progress) {
    progress.beginStep(unit.itemId, 'commit', unit.commitLabel);
  } else {
    process.stdout.write(`\n→ [4/4] ${unit.commitConsole}\n`);
  }
  if (dryRun) {
    for (const repo of targetRepos) {
      process.stdout.write(
        `  (dry-run) git -C ${repo.path} add -A && ` +
          `git -C ${repo.path} commit -m "${unit.commitMessage}"\n`,
      );
    }
    return { alreadyDone: false };
  }
  const dirtyTargets = dirtyRepos(targetRepos);
  if (dirtyTargets.length === 0) {
    progress?.endStep(unit.itemId, 'commit', 'failed');
    throw new RunFailure('commit', 'no target repo has changes to commit', unit.prId);
  }
  const failure = commitAllTargetRepos(dirtyTargets, unit.commitMessage, progress);
  if (failure !== null) {
    progress?.endStep(unit.itemId, 'commit', 'failed');
    throw new RunFailure(
      'commit',
      formatCommitFailureMessage({
        repoName: failure.repo.name,
        repoPath: failure.repo.path,
        commitSubject: unit.commitMessage,
        slug: unit.slug,
        exitCode: failure.commit.code,
        gitTail: commitGitTail(failure.commit),
      }),
      unit.prId,
    );
  }
  progress?.endStep(unit.itemId, 'commit', 'done');
  return { alreadyDone: false };
}

export async function runPr(opts: RunPrOptions): Promise<ExecutionUnitResult> {
  const { pr, plan, planPath, parentLogDir, targetRepos, dryRun, progress, signal } = opts;
  const repoPaths = targetRepos.map((repo) => repo.path);
  return await runExecutionUnit({
    unit: {
      itemId: pr.id,
      prId: pr.id,
      slug: plan.slug,
      banner: `PR ${pr.id} — ${pr.title}`,
      implementConsole: `claude implementing PR ${pr.id}`,
      reviewConsole: `codex reviewing uncommitted changes for PR ${pr.id}`,
      fixConsole: `claude addressing review for PR ${pr.id}`,
      commitConsole: `committing PR ${pr.id}`,
      implementLabel: `claude · implement · PR ${pr.id}`,
      reviewLabel: `codex · review · PR ${pr.id}`,
      fixLabel: `claude · fix · PR ${pr.id}`,
      commitLabel: `git · commit · PR ${pr.id}`,
      implementPrompt: implementPrompt(pr, planPath, repoPaths),
      reviewPrompt: reviewPrompt(pr, planPath, repoPaths),
      fixPrompt: (reviewText) => fixPrompt(pr, reviewText),
      commitMessage: prCommitMessage(plan, pr),
      logDir: prLogDir(parentLogDir, pr),
    },
    targetRepos,
    dryRun,
    ...(progress !== undefined ? { progress } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
}

export async function runPlanSingleUnit(
  opts: RunPlanSingleUnitOptions,
): Promise<ExecutionUnitResult> {
  const { plan, planText, parentLogDir, targetRepos, dryRun, progress, signal } = opts;
  const repoPaths = targetRepos.map((repo) => repo.path);
  const implementText = implementPlanPrompt(plan, planText, repoPaths);
  return await runExecutionUnit({
    unit: {
      itemId: plan.slug,
      prId: null,
      slug: plan.slug,
      banner: `plan ${plan.slug} — ${plan.title}`,
      implementConsole: `claude implementing ${plan.slug}`,
      reviewConsole: `codex reviewing uncommitted changes for ${plan.slug}`,
      fixConsole: `claude addressing review for ${plan.slug}`,
      commitConsole: `committing ${plan.slug}`,
      implementLabel: `claude · implement · ${plan.slug}`,
      reviewLabel: `codex · review · ${plan.slug}`,
      fixLabel: `claude · fix · ${plan.slug}`,
      commitLabel: `git · commit · ${plan.slug}`,
      implementPrompt: implementText,
      reviewPrompt: reviewPlanPrompt(plan, repoPaths),
      fixPrompt: (reviewText) => fixPlanPrompt(plan, reviewText),
      commitMessage: planCommitMessage(plan),
      logDir: parentLogDir,
      dryRunImplementArgs: [
        'claude',
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '<plan-prompt>',
      ],
    },
    targetRepos,
    dryRun,
    ...(progress !== undefined ? { progress } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
}

export interface RunPlanOptions {
  plan: Plan;
  dryRun: boolean;
  targetRepos?: readonly ResolvedWorkspaceRepo[];
  progress?: ProgressSink;
  signal?: AbortSignal;
  /**
   * Persist a PR-list mutation. Called before a PR starts (to record
   * `started_at`) and after it finishes (to record status + commit subject).
   * The watcher implements this by writing back to the todo store with
   * `allowImplementing: true`. Omit in dry-run paths.
   */
  onPrUpdate?: (prs: PrEntry[]) => Promise<void>;
}

async function resolvePlanRepos(plan: Plan): Promise<ResolvedWorkspaceRepo[]> {
  try {
    return await resolveWorkspaceRepos(plan.target_repos);
  } catch (err) {
    if (err instanceof WorkspaceConfigError) {
      const targets = plan.target_repos.length === 0 ? '(all)' : plan.target_repos.join(', ');
      throw new WorkspaceConfigError(
        `plan '${plan.slug}' target_repos [${targets}]: ${err.message}`,
      );
    }
    throw err;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRunnable(entry: PrEntry): boolean {
  return entry.status !== 'done' && entry.status !== 'orphaned';
}

export async function runPlan(opts: RunPlanOptions): Promise<void> {
  const { plan, dryRun, progress, signal, onPrUpdate } = opts;
  const targetRepos = opts.targetRepos ?? (await resolvePlanRepos(plan));
  const planText = await fs.readFile(planFilePath(plan), 'utf8');
  const parentLogDir = planLogDir(plan);
  await fs.mkdir(parentLogDir, { recursive: true });

  const storedPrs = plan.prs;
  if (storedPrs === null || storedPrs.length === 0) {
    progress?.beginItem(plan.slug);
    try {
      await runPlanSingleUnit({
        plan,
        planText,
        parentLogDir,
        targetRepos,
        dryRun,
        ...(progress !== undefined ? { progress } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (err) {
      progress?.endItem(plan.slug, 'failed');
      throw err;
    }
    progress?.endItem(plan.slug, 'done');
    return;
  }

  // Take a mutable working copy. `onPrUpdate` persists this list after every
  // transition so a crash mid-plan never loses progress and `lauren vibe
  // retry` resumes from the right PR.
  const prs: PrEntry[] = storedPrs.map((e) => ({ ...e }));
  if (progress) {
    for (const pr of prs) {
      if (pr.status === 'done') progress.markItemDone(pr.id);
    }
  }

  for (let i = 0; i < prs.length; i++) {
    const entry = prs[i]!;
    if (!isRunnable(entry)) continue;
    const startedAt = nowIso();
    prs[i] = {
      ...entry,
      status: 'pending',
      started_at: startedAt,
      finished_at: null,
      commit_subject: null,
    };
    await onPrUpdate?.(prs);
    progress?.beginItem(entry.id);
    const pr: PR = { id: entry.id, title: entry.title };
    let result: ExecutionUnitResult;
    try {
      result = await runPr({
        pr,
        plan,
        planPath: plan.path,
        parentLogDir,
        targetRepos,
        dryRun,
        ...(progress !== undefined ? { progress } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (err) {
      prs[i] = { ...prs[i]!, status: 'failed', finished_at: nowIso() };
      await onPrUpdate?.(prs).catch(() => undefined);
      progress?.endItem(entry.id, 'failed');
      throw err;
    }
    prs[i] = {
      ...prs[i]!,
      status: 'done',
      finished_at: nowIso(),
      commit_subject: result.alreadyDone ? null : prCommitMessage(plan, pr),
    };
    await onPrUpdate?.(prs);
    progress?.endItem(entry.id, 'done');
  }
}

// REPO is re-exported for any future call site that may want it; keeps
// implicit dependency on cwd resolution centralized.
export { REPO };
