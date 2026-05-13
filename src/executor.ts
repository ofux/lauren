import { promises as fs } from 'node:fs';
import path from 'node:path';

import { nextPendingCheckpointAfter } from './core/checkpoints.js';
import { displayPath } from './core/paths.js';
import type { Step, StepEntry } from './core/steps.js';
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
  reviewPlanPrompt,
  reviewPrompt,
  stepCommitMessage,
} from './executor-prompts.js';
import { runCodexReview } from './proc/codex.js';
import { type GitCommitResult, gitAddAll, gitCommit, workingTreeDirty } from './proc/git.js';
import { streamSubprocess } from './proc/stream.js';
import { formatClaudeStreamLine } from './util/streamJson.js';

export type PhaseName = 'implement' | 'review' | 'fix' | 'commit';
export type PhaseStatus = 'done' | 'failed' | 'skipped';
export type ItemStatus = 'done' | 'failed';

export const STEP_PHASES: readonly PhaseName[] = ['implement', 'review', 'fix', 'commit'] as const;

export class RunFailure extends Error {
  readonly phase: PhaseName | 'unknown';
  readonly stepId: string | null;
  /** The original message, without the `${phase}: ` prefix added to Error.message. */
  readonly rawMessage: string;
  constructor(phase: PhaseName | 'unknown', message: string, stepId: string | null = null) {
    super(`${phase}: ${message}`);
    this.name = 'RunFailure';
    this.phase = phase;
    this.stepId = stepId;
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
  beginPhase(itemId: string, phase: PhaseName, label: string): void;
  endPhase(itemId: string, phase: PhaseName, status: PhaseStatus): void;
}

function stepLogDir(parentLogDir: string, step: Step): string {
  return path.join(parentLogDir, `Step-${step.id}`);
}

function banner(text: string): void {
  const bar = '═'.repeat(Math.max(60, text.length + 4));
  process.stdout.write(`\n${bar}\n  ${text}\n${bar}\n`);
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
    `Then press \`t\` on '${slug}' in \`lauren\` to reset it to ready.`,
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
 * subject. The Step row is marked `failed` in the todo store, so when the user
 * presses `t` on the row in `lauren` (or restarts `lauren vibe` after a manual
 * fix) the Step re-runs — pick scopes that minimize cross-repo coupling so
 * manual recovery + retry doesn't fight a duplicate commit in repo A.
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
 * phase exited cleanly but produced no diff — we treat that as "the work was
 * already there" and skip review/fix/commit. The caller uses this to decide
 * whether to record a `commit_subject` on the Step row.
 */
export interface ExecutionUnitResult {
  alreadyDone: boolean;
}

interface RunUnitArgs {
  plan: Plan;
  /** Step-mode when set; single-unit mode when null. */
  step: Step | null;
  /** Full plan markdown — required for single-unit (`step === null`), unused otherwise. */
  planText: string | null;
  parentLogDir: string;
  targetRepos: readonly ResolvedWorkspaceRepo[];
  /**
   * Working directory for claude/codex subprocesses. The executor never
   * shells into the user's main checkout — this is the worktree root for
   * the in-flight plan. Git commit operations use `targetRepos[i].root`
   * (which the watcher has already rewritten to per-repo worktree paths).
   */
  cwd: string;
  dryRun: boolean;
  progress?: ProgressSink;
  signal?: AbortSignal;
}

async function runUnit(args: RunUnitArgs): Promise<ExecutionUnitResult> {
  const { plan, step, planText, parentLogDir, targetRepos, cwd, dryRun, progress, signal } = args;
  const repoPaths = targetRepos.map((repo) => repo.path);

  const itemId = step ? step.id : plan.slug;
  const stepId: string | null = step ? step.id : null;
  const label = step ? `Step ${step.id}` : plan.slug;
  const bannerText = step ? `Step ${step.id} — ${step.title}` : `plan ${plan.slug} — ${plan.title}`;
  const logDir = step ? stepLogDir(parentLogDir, step) : parentLogDir;
  const commitMessage = step ? stepCommitMessage(plan, step) : planCommitMessage(plan);
  const implementText = step
    ? implementPrompt(step, plan.path, repoPaths)
    : implementPlanPrompt(plan, planText ?? '', repoPaths);
  const reviewText0 = step
    ? reviewPrompt(step, plan.path, repoPaths)
    : reviewPlanPrompt(plan, repoPaths);
  const buildFixPrompt = (reviewText: string): string =>
    step ? fixPrompt(step, reviewText) : fixPlanPrompt(plan, reviewText);
  const dryRunImplementArgs = step
    ? undefined
    : ['claude', '-p', '--output-format', 'stream-json', '--verbose', '<plan-prompt>'];

  await fs.mkdir(logDir, { recursive: true });
  if (!progress) banner(bannerText);

  const dirtyBeforeStart = dirtyRepos(targetRepos);
  if (dirtyBeforeStart.length > 0) {
    throw new RunFailure(
      'implement',
      `target repo(s) are dirty before starting: ${formatRepos(
        dirtyBeforeStart,
      )}; commit or stash changes first.`,
      stepId,
    );
  }

  const implementCmd = claudePrintCommand(implementText);
  if (progress) {
    progress.beginPhase(itemId, 'implement', `claude · implement · ${label}`);
  } else {
    process.stdout.write(`\n→ [1/4] claude implementing ${label}\n`);
  }
  if (dryRun) {
    const displayArgs = dryRunImplementArgs ?? implementCmd;
    process.stdout.write(`  (dry-run) ${displayArgs.map((a) => JSON.stringify(a)).join(' ')}\n`);
  } else {
    const sinkArg = progress ?? undefined;
    const logPath = path.join(logDir, '1-implement.log');
    const rc = await streamSubprocess({
      cmd: implementCmd,
      logPath,
      cwd,
      ...(sinkArg !== undefined ? { sink: sinkArg } : {}),
      ...(signal !== undefined ? { signal } : {}),
      transformer: formatClaudeStreamLine,
    });
    if (rc !== 0) {
      progress?.endPhase(itemId, 'implement', 'failed');
      throw new RunFailure('implement', `claude exited ${rc}`, stepId);
    }
    progress?.endPhase(itemId, 'implement', 'done');
    if (dirtyRepos(targetRepos).length === 0) {
      const note =
        'no changes after implement — assuming work was already done; ' +
        'skipping review/fix/commit';
      if (progress) {
        progress.appendLog(`(${note})`);
        progress.endPhase(itemId, 'review', 'skipped');
        progress.endPhase(itemId, 'fix', 'skipped');
        progress.endPhase(itemId, 'commit', 'skipped');
      } else {
        process.stdout.write(`  ${note} (see ${displayPath(logPath)})\n`);
      }
      return { alreadyDone: true };
    }
  }

  const reviewMessagePath = path.join(logDir, '2-review.message.txt');
  if (progress) {
    progress.beginPhase(itemId, 'review', `codex · review · ${label}`);
  } else {
    process.stdout.write(`\n→ [2/4] codex reviewing uncommitted changes for ${label}\n`);
  }
  let reviewText = '';
  if (dryRun) {
    process.stdout.write(`  (dry-run) codex exec review -o ${reviewMessagePath} <review-prompt>\n`);
  } else {
    const sinkArg = progress ?? undefined;
    const { code, reviewText: text } = await runCodexReview({
      prompt: reviewText0,
      outputPath: reviewMessagePath,
      logPath: path.join(logDir, '2-review.log'),
      cwd,
      ...(sinkArg !== undefined ? { sink: sinkArg } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (code !== 0) {
      progress?.endPhase(itemId, 'review', 'failed');
      throw new RunFailure('review', `codex exited ${code}`, stepId);
    }
    reviewText = text;
    if (progress) {
      progress.endPhase(itemId, 'review', 'done');
    } else if (reviewText.trim().length === 0) {
      process.stdout.write('  (warning) codex returned an empty review; skipping fix step.\n');
    }
  }

  if (dryRun) {
    process.stdout.write(`\n→ [3/4] (dry-run) claude addressing review for ${label}\n`);
  } else if (reviewText.trim().length > 0) {
    const fixCmd = claudePrintCommand(buildFixPrompt(reviewText));
    if (progress) {
      progress.beginPhase(itemId, 'fix', `claude · fix · ${label}`);
    } else {
      process.stdout.write(`\n→ [3/4] claude addressing review for ${label}\n`);
    }
    const sinkArg = progress ?? undefined;
    const rc = await streamSubprocess({
      cmd: fixCmd,
      logPath: path.join(logDir, '3-fix.log'),
      cwd,
      ...(sinkArg !== undefined ? { sink: sinkArg } : {}),
      ...(signal !== undefined ? { signal } : {}),
      transformer: formatClaudeStreamLine,
    });
    if (rc !== 0) {
      progress?.endPhase(itemId, 'fix', 'failed');
      throw new RunFailure('fix', `claude exited ${rc}`, stepId);
    }
    progress?.endPhase(itemId, 'fix', 'done');
  } else {
    progress?.endPhase(itemId, 'fix', 'skipped');
  }

  if (progress) {
    progress.beginPhase(itemId, 'commit', `git · commit · ${label}`);
  } else {
    process.stdout.write(`\n→ [4/4] committing ${label}\n`);
  }
  if (dryRun) {
    for (const repo of targetRepos) {
      process.stdout.write(
        `  (dry-run) git -C ${repo.path} add -A && ` +
          `git -C ${repo.path} commit -m "${commitMessage}"\n`,
      );
    }
    return { alreadyDone: false };
  }
  const dirtyTargets = dirtyRepos(targetRepos);
  if (dirtyTargets.length === 0) {
    progress?.endPhase(itemId, 'commit', 'failed');
    throw new RunFailure('commit', 'no target repo has changes to commit', stepId);
  }
  let failure: ReturnType<typeof commitAllTargetRepos>;
  try {
    failure = commitAllTargetRepos(dirtyTargets, commitMessage, progress);
  } catch (err) {
    progress?.endPhase(itemId, 'commit', 'failed');
    const msg = err instanceof Error ? err.message : String(err);
    throw new RunFailure('commit', msg, stepId);
  }
  if (failure !== null) {
    progress?.endPhase(itemId, 'commit', 'failed');
    throw new RunFailure(
      'commit',
      formatCommitFailureMessage({
        repoName: failure.repo.name,
        repoPath: failure.repo.path,
        commitSubject: commitMessage,
        slug: plan.slug,
        exitCode: failure.commit.code,
        gitTail: commitGitTail(failure.commit),
      }),
      stepId,
    );
  }
  progress?.endPhase(itemId, 'commit', 'done');
  return { alreadyDone: false };
}

export interface RunPlanOptions {
  plan: Plan;
  dryRun: boolean;
  targetRepos?: readonly ResolvedWorkspaceRepo[];
  /**
   * Working directory for claude/codex subprocesses. Defaults to the main
   * repo root when omitted (dry-run paths). In real runs the watcher
   * passes the plan's worktree root here.
   */
  cwd?: string;
  progress?: ProgressSink;
  signal?: AbortSignal;
  /**
   * Persist a Step-list mutation. Called before a Step starts (to record
   * `started_at`) and after it finishes (to record status + commit subject).
   * The watcher implements this by writing back to the todo store with
   * `allowImplementing: true`. Omit in dry-run paths.
   */
  onStepUpdate?: (steps: StepEntry[]) => Promise<void>;
}

/**
 * Outcome of a `runPlan` call. `completed` is the happy path; the watcher
 * transitions the row to `merging` (or `done` for single-unit) on this.
 * `paused-at-checkpoint` means the executor committed all the work it
 * could and then hit a pending Human Checkpoint — the watcher should
 * transition the row to `awaiting_human` and stop without finalizing. The
 * failure path still throws.
 */
export type RunPlanResult =
  | { kind: 'completed' }
  | { kind: 'paused-at-checkpoint'; checkpoint_id: string };

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

function isRunnable(entry: StepEntry): boolean {
  return entry.status !== 'done' && entry.status !== 'orphaned';
}

function hasCompletedSingleUnitCheckpoint(plan: Plan): boolean {
  return (
    plan.checkpoints?.some((cp) => cp.after_step_id === '__unit__' && cp.status === 'done') ?? false
  );
}

export async function runPlan(opts: RunPlanOptions): Promise<RunPlanResult> {
  const { plan, dryRun, progress, signal, onStepUpdate } = opts;
  const targetRepos = opts.targetRepos ?? (await resolvePlanRepos(plan));
  // Subprocess cwd: the worktree root passed by the watcher in real runs;
  // falls back to the main repo for dry-run/test paths that don't allocate
  // a worktree.
  const cwd = opts.cwd ?? targetRepos[0]?.root ?? process.cwd();
  const planText = await fs.readFile(planFilePath(plan), 'utf8');
  const parentLogDir = planLogDir(plan);
  await fs.mkdir(parentLogDir, { recursive: true });

  const storedSteps = plan.steps;
  if (storedSteps === null || storedSteps.length === 0) {
    if (hasCompletedSingleUnitCheckpoint(plan)) {
      return { kind: 'completed' };
    }
    progress?.beginItem(plan.slug);
    try {
      await runUnit({
        plan,
        step: null,
        planText,
        parentLogDir,
        targetRepos,
        cwd,
        dryRun,
        ...(progress !== undefined ? { progress } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (err) {
      progress?.endItem(plan.slug, 'failed');
      throw err;
    }
    progress?.endItem(plan.slug, 'done');
    // Single-unit: honor a trailing checkpoint if present. The whole plan
    // body just landed as one commit; pause now before declaring complete.
    const trailingSingleUnit = nextPendingCheckpointAfter(plan.checkpoints, '__unit__');
    if (trailingSingleUnit) {
      return { kind: 'paused-at-checkpoint', checkpoint_id: trailingSingleUnit.id };
    }
    return { kind: 'completed' };
  }

  // Leading checkpoint (multi-step): pause before running the first Step.
  // Skip if there are no Steps left to run anyway.
  const leadingCheckpoint = nextPendingCheckpointAfter(plan.checkpoints, null);
  if (leadingCheckpoint && storedSteps.some(isRunnable)) {
    return { kind: 'paused-at-checkpoint', checkpoint_id: leadingCheckpoint.id };
  }

  // Take a mutable working copy. `onStepUpdate` persists this list after every
  // transition so a crash mid-plan never loses progress and `lauren vibe
  // retry` resumes from the right Step.
  const steps: StepEntry[] = storedSteps.map((e) => ({ ...e }));
  if (progress) {
    for (const step of steps) {
      if (step.status === 'done') progress.markItemDone(step.id);
    }
  }

  for (let i = 0; i < steps.length; i++) {
    const entry = steps[i]!;
    if (!isRunnable(entry)) {
      if (entry.status === 'done') {
        const nextCp = nextPendingCheckpointAfter(plan.checkpoints, entry.id);
        if (nextCp) {
          return { kind: 'paused-at-checkpoint', checkpoint_id: nextCp.id };
        }
      }
      continue;
    }
    const startedAt = nowIso();
    steps[i] = {
      ...entry,
      status: 'pending',
      started_at: startedAt,
      finished_at: null,
      commit_subject: null,
    };
    await onStepUpdate?.(steps);
    progress?.beginItem(entry.id);
    const step: Step = { id: entry.id, title: entry.title };
    let result: ExecutionUnitResult;
    try {
      result = await runUnit({
        plan,
        step,
        planText: null,
        parentLogDir,
        targetRepos,
        cwd,
        dryRun,
        ...(progress !== undefined ? { progress } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (err) {
      steps[i] = { ...steps[i]!, status: 'failed', finished_at: nowIso() };
      await onStepUpdate?.(steps).catch(() => undefined);
      progress?.endItem(entry.id, 'failed');
      throw err;
    }
    steps[i] = {
      ...steps[i]!,
      status: 'done',
      finished_at: nowIso(),
      commit_subject: result.alreadyDone ? null : stepCommitMessage(plan, step),
    };
    await onStepUpdate?.(steps);
    progress?.endItem(entry.id, 'done');

    // Pause if a checkpoint sits immediately after this Step's commit.
    // The match is `after_step_id === entry.id`. Catches the post-last-step
    // case naturally since the last Step's id equals after_step_id there.
    const nextCp = nextPendingCheckpointAfter(plan.checkpoints, entry.id);
    if (nextCp) {
      return { kind: 'paused-at-checkpoint', checkpoint_id: nextCp.id };
    }
  }

  return { kind: 'completed' };
}
