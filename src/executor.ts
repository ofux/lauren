import { promises as fs } from 'node:fs';
import path from 'node:path';

import { displayPath, REPO } from './core/paths.js';
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
  type PR,
  planCommitMessage,
  prCommitMessage,
  reviewPlanPrompt,
  reviewPrompt,
} from './executor-prompts.js';
import { runCodexReview } from './proc/codex.js';
import {
  type GitCommitResult,
  gitAddAll,
  gitCommit,
  gitLogSubjects,
  workingTreeDirty,
} from './proc/git.js';
import { streamSubprocess } from './proc/stream.js';
import { formatClaudeStreamLine } from './util/streamJson.js';

export type StepName = 'implement' | 'review' | 'fix' | 'commit';
export type StepStatus = 'done' | 'failed' | 'skipped';
export type ItemStatus = 'done' | 'failed';

const PR_HEADING_RE = /^### PR (\d+\.\d+) — (.+?)\s*$/;

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

export function parsePrs(text: string): PR[] {
  const seen = new Set<string>();
  const out: PR[] = [];
  for (const line of text.split('\n')) {
    const m = PR_HEADING_RE.exec(line);
    if (!m) continue;
    const [, id, rawTitle] = m;
    if (id === undefined || rawTitle === undefined) continue;
    const title = rawTitle.trim();
    if (seen.has(id)) {
      throw new Error(`duplicate PR id ${id} in plan`);
    }
    seen.add(id);
    out.push({ id, title });
  }
  return out;
}

export function parseDoneIds(subjects: string[], slug: string): Set<string> {
  const slugEsc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${slugEsc}: PR (\\d+\\.\\d+) — `);
  const done = new Set<string>();
  for (const line of subjects) {
    const m = re.exec(line);
    if (m?.[1]) done.add(m[1]);
  }
  return done;
}

export function alreadyDone(plan: Plan, cwd?: string): Set<string> {
  return parseDoneIds(gitLogSubjects(cwd), plan.slug);
}

/**
 * Resume detection across a workspace. A PR id is considered done if *any*
 * target repo has the marker commit for it. We don't require markers in
 * every target repo because we no longer create empty placeholders — peers
 * that had no real changes during the original run simply have no marker.
 */
export function alreadyDoneInRepos(
  plan: Plan,
  repos: readonly ResolvedWorkspaceRepo[],
): Set<string> {
  const done = new Set<string>();
  for (const repo of repos) {
    for (const id of alreadyDone(plan, repo.root)) done.add(id);
  }
  return done;
}

function legacyPlanCommitMessage(plan: Plan): string {
  return `Plan: ${plan.title}`;
}

export function singleUnitDone(plan: Plan, cwd?: string): boolean {
  const subjects = gitLogSubjects(cwd);
  return (
    subjects.includes(planCommitMessage(plan)) || subjects.includes(legacyPlanCommitMessage(plan))
  );
}

export function singleUnitDoneInRepos(
  plan: Plan,
  repos: readonly ResolvedWorkspaceRepo[],
): boolean {
  return repos.some((repo) => singleUnitDone(plan, repo.root));
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
 * subject. On retry, `alreadyDone` sees the marker in both repos and
 * correctly skips this PR. (If the user commits B with a different subject,
 * resume will re-run the PR — still pick scopes that minimize cross-repo
 * coupling to keep recovery cheap.)
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

async function runExecutionUnit(args: {
  unit: ExecutionUnit;
  targetRepos: readonly ResolvedWorkspaceRepo[];
  dryRun: boolean;
  progress?: ProgressSink;
  signal?: AbortSignal;
}): Promise<void> {
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
    if (dirtyRepos(targetRepos).length === 0) {
      progress?.endStep(unit.itemId, 'implement', 'failed');
      throw new RunFailure(
        'implement',
        `claude produced no changes in target repo(s) ${formatRepos(targetRepos)} ` +
          `(see ${displayPath(logPath)})`,
        unit.prId,
      );
    }
    progress?.endStep(unit.itemId, 'implement', 'done');
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
    return;
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
}

export async function runPr(opts: RunPrOptions): Promise<void> {
  const { pr, plan, planPath, parentLogDir, targetRepos, dryRun, progress, signal } = opts;
  const repoPaths = targetRepos.map((repo) => repo.path);
  await runExecutionUnit({
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

export async function runPlanSingleUnit(opts: RunPlanSingleUnitOptions): Promise<void> {
  const { plan, planText, parentLogDir, targetRepos, dryRun, progress, signal } = opts;
  const repoPaths = targetRepos.map((repo) => repo.path);
  const implementText = implementPlanPrompt(plan, planText, repoPaths);
  await runExecutionUnit({
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

export async function runPlan(opts: RunPlanOptions): Promise<void> {
  const { plan, dryRun, progress, signal } = opts;
  const targetRepos = opts.targetRepos ?? (await resolvePlanRepos(plan));
  const planText = await fs.readFile(planFilePath(plan), 'utf8');
  const prs = parsePrs(planText);
  const parentLogDir = planLogDir(plan);
  await fs.mkdir(parentLogDir, { recursive: true });

  if (prs.length === 0) {
    if (singleUnitDoneInRepos(plan, targetRepos)) {
      progress?.markItemDone(plan.slug);
      return;
    }
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

  const done = alreadyDoneInRepos(plan, targetRepos);
  if (progress) {
    for (const pr of prs) {
      if (done.has(pr.id)) progress.markItemDone(pr.id);
    }
  }

  for (const pr of prs) {
    if (done.has(pr.id)) continue;
    progress?.beginItem(pr.id);
    try {
      await runPr({
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
      progress?.endItem(pr.id, 'failed');
      throw err;
    }
    progress?.endItem(pr.id, 'done');
  }
}

// REPO is re-exported for any future call site that may want it; keeps
// implicit dependency on cwd resolution centralized.
export { REPO };
