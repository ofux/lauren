import { promises as fs } from 'node:fs';
import path from 'node:path';

import { displayPath, REPO } from './core/paths.js';
import { type Plan, planFilePath, planLogDir } from './core/types.js';
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
import { gitAddAll, gitCommit, gitLogSubjects, workingTreeDirty } from './proc/git.js';
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
  constructor(step: StepName | 'unknown', message: string, prId: string | null = null) {
    super(`${step}: ${message}`);
    this.name = 'RunFailure';
    this.step = step;
    this.prId = prId;
  }
}

/**
 * Sink that observes runner progress. Implementations: a TUI bridge in
 * vibe.ts, or undefined (the runner falls back to plain stdout banners).
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

export function alreadyDone(plan: Plan): Set<string> {
  const done = new Set<string>();
  const subjects = gitLogSubjects();
  const slugEsc = plan.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${slugEsc}: PR (\\d+\\.\\d+) — `);
  for (const line of subjects) {
    const m = re.exec(line);
    if (m?.[1]) done.add(m[1]);
  }
  return done;
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
  dryRun: boolean;
  progress?: ProgressSink;
}

export async function runPr(opts: RunPrOptions): Promise<void> {
  const { pr, plan, planPath, parentLogDir, dryRun, progress } = opts;
  const logDir = prLogDir(parentLogDir, pr);
  await fs.mkdir(logDir, { recursive: true });
  if (!progress) banner(`PR ${pr.id} — ${pr.title}`);

  if (workingTreeDirty()) {
    throw new RunFailure(
      'implement',
      'working tree is dirty before starting; commit or stash changes first.',
      pr.id,
    );
  }

  // Step 1 — implement
  const implementCmd = [
    'claude',
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    implementPrompt(pr, planPath),
  ];
  if (progress) {
    progress.beginStep(pr.id, 'implement', `claude · implement · PR ${pr.id}`);
  } else {
    process.stdout.write(`\n→ [1/4] claude implementing PR ${pr.id}\n`);
  }
  if (dryRun) {
    process.stdout.write(`  (dry-run) ${implementCmd.map((a) => JSON.stringify(a)).join(' ')}\n`);
  } else {
    const sinkArg = progress ?? undefined;
    const rc = await streamSubprocess({
      cmd: implementCmd,
      logPath: path.join(logDir, '1-implement.log'),
      ...(sinkArg !== undefined ? { sink: sinkArg } : {}),
      transformer: formatClaudeStreamLine,
    });
    if (rc !== 0) {
      progress?.endStep(pr.id, 'implement', 'failed');
      throw new RunFailure('implement', `claude exited ${rc}`, pr.id);
    }
    if (!workingTreeDirty()) {
      progress?.endStep(pr.id, 'implement', 'failed');
      throw new RunFailure(
        'implement',
        `claude produced no changes (see ${displayPath(path.join(logDir, '1-implement.log'))})`,
        pr.id,
      );
    }
    progress?.endStep(pr.id, 'implement', 'done');
  }

  // Step 2 — review via codex
  const reviewMessagePath = path.join(logDir, '2-review.message.txt');
  if (progress) {
    progress.beginStep(pr.id, 'review', `codex · review · PR ${pr.id}`);
  } else {
    process.stdout.write(`\n→ [2/4] codex reviewing uncommitted changes for PR ${pr.id}\n`);
  }
  let reviewText = '';
  if (dryRun) {
    process.stdout.write(`  (dry-run) codex exec review -o ${reviewMessagePath} <review-prompt>\n`);
  } else {
    const sinkArg = progress ?? undefined;
    const { code, reviewText: text } = await runCodexReview({
      prompt: reviewPrompt(pr, planPath),
      outputPath: reviewMessagePath,
      logPath: path.join(logDir, '2-review.log'),
      ...(sinkArg !== undefined ? { sink: sinkArg } : {}),
    });
    if (code !== 0) {
      progress?.endStep(pr.id, 'review', 'failed');
      throw new RunFailure('review', `codex exited ${code}`, pr.id);
    }
    reviewText = text;
    if (progress) {
      progress.endStep(pr.id, 'review', 'done');
    } else if (reviewText.trim().length === 0) {
      process.stdout.write('  (warning) codex returned an empty review; skipping fix step.\n');
    }
  }

  // Step 3 — fix
  if (dryRun) {
    process.stdout.write(`\n→ [3/4] (dry-run) claude addressing review for PR ${pr.id}\n`);
  } else if (reviewText.trim().length > 0) {
    const fixCmd = [
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      fixPrompt(pr, reviewText),
    ];
    if (progress) {
      progress.beginStep(pr.id, 'fix', `claude · fix · PR ${pr.id}`);
    } else {
      process.stdout.write(`\n→ [3/4] claude addressing review for PR ${pr.id}\n`);
    }
    const sinkArg = progress ?? undefined;
    const rc = await streamSubprocess({
      cmd: fixCmd,
      logPath: path.join(logDir, '3-fix.log'),
      ...(sinkArg !== undefined ? { sink: sinkArg } : {}),
      transformer: formatClaudeStreamLine,
    });
    if (rc !== 0) {
      progress?.endStep(pr.id, 'fix', 'failed');
      throw new RunFailure('fix', `claude exited ${rc}`, pr.id);
    }
    progress?.endStep(pr.id, 'fix', 'done');
  } else {
    progress?.endStep(pr.id, 'fix', 'skipped');
  }

  // Step 4 — commit
  if (progress) {
    progress.beginStep(pr.id, 'commit', `git · commit · PR ${pr.id}`);
  } else {
    process.stdout.write(`\n→ [4/4] committing PR ${pr.id}\n`);
  }
  const message = prCommitMessage(plan, pr);
  if (dryRun) {
    process.stdout.write(`  (dry-run) git add -A && git commit -m "${message}"\n`);
    return;
  }
  gitAddAll();
  const commit = gitCommit(message, { capture: progress !== undefined });
  if (commit.code !== 0) {
    progress?.endStep(pr.id, 'commit', 'failed');
    let detail = '';
    if (progress) {
      const captured = (commit.stderr ?? '') + (commit.stdout ?? '');
      const tail = captured
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (tail.length > 0) detail = `: ${tail[tail.length - 1]}`;
    }
    throw new RunFailure('commit', `git commit exited ${commit.code}${detail}`, pr.id);
  }
  progress?.endStep(pr.id, 'commit', 'done');
}

export interface RunPlanSingleUnitOptions {
  plan: Plan;
  planText: string;
  parentLogDir: string;
  dryRun: boolean;
  progress?: ProgressSink;
}

export async function runPlanSingleUnit(opts: RunPlanSingleUnitOptions): Promise<void> {
  const { plan, planText, parentLogDir, dryRun, progress } = opts;
  const logDir = parentLogDir;
  await fs.mkdir(logDir, { recursive: true });
  const itemId = plan.slug;

  if (workingTreeDirty()) {
    throw new RunFailure(
      'implement',
      'working tree is dirty before starting; commit or stash changes first.',
    );
  }

  if (!progress) banner(`plan ${plan.slug} — ${plan.title}`);

  // Step 1 — implement
  const implementCmd = [
    'claude',
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    implementPlanPrompt(plan, planText),
  ];
  if (progress) {
    progress.beginStep(itemId, 'implement', `claude · implement · ${plan.slug}`);
  } else {
    process.stdout.write(`\n→ [1/4] claude implementing ${plan.slug}\n`);
  }
  if (dryRun) {
    process.stdout.write(
      `  (dry-run) ${implementCmd
        .slice(0, 5)
        .map((a) => JSON.stringify(a))
        .join(' ')} <plan-prompt>\n`,
    );
  } else {
    const sinkArg = progress ?? undefined;
    const rc = await streamSubprocess({
      cmd: implementCmd,
      logPath: path.join(logDir, '1-implement.log'),
      ...(sinkArg !== undefined ? { sink: sinkArg } : {}),
      transformer: formatClaudeStreamLine,
    });
    if (rc !== 0) {
      progress?.endStep(itemId, 'implement', 'failed');
      throw new RunFailure('implement', `claude exited ${rc}`);
    }
    if (!workingTreeDirty()) {
      progress?.endStep(itemId, 'implement', 'failed');
      throw new RunFailure(
        'implement',
        `claude produced no changes (see ${displayPath(path.join(logDir, '1-implement.log'))})`,
      );
    }
    progress?.endStep(itemId, 'implement', 'done');
  }

  // Step 2 — review
  const reviewMessagePath = path.join(logDir, '2-review.message.txt');
  if (progress) {
    progress.beginStep(itemId, 'review', `codex · review · ${plan.slug}`);
  } else {
    process.stdout.write(`\n→ [2/4] codex reviewing uncommitted changes for ${plan.slug}\n`);
  }
  let reviewText = '';
  if (dryRun) {
    process.stdout.write(`  (dry-run) codex exec review -o ${reviewMessagePath} <review-prompt>\n`);
  } else {
    const sinkArg = progress ?? undefined;
    const { code, reviewText: text } = await runCodexReview({
      prompt: reviewPlanPrompt(plan),
      outputPath: reviewMessagePath,
      logPath: path.join(logDir, '2-review.log'),
      ...(sinkArg !== undefined ? { sink: sinkArg } : {}),
    });
    if (code !== 0) {
      progress?.endStep(itemId, 'review', 'failed');
      throw new RunFailure('review', `codex exited ${code}`);
    }
    reviewText = text;
    if (progress) {
      progress.endStep(itemId, 'review', 'done');
    } else if (reviewText.trim().length === 0) {
      process.stdout.write('  (warning) codex returned an empty review; skipping fix step.\n');
    }
  }

  // Step 3 — fix
  if (dryRun) {
    process.stdout.write(`\n→ [3/4] (dry-run) claude addressing review for ${plan.slug}\n`);
  } else if (reviewText.trim().length > 0) {
    const fixCmd = [
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      fixPlanPrompt(plan, reviewText),
    ];
    if (progress) {
      progress.beginStep(itemId, 'fix', `claude · fix · ${plan.slug}`);
    } else {
      process.stdout.write(`\n→ [3/4] claude addressing review for ${plan.slug}\n`);
    }
    const sinkArg = progress ?? undefined;
    const rc = await streamSubprocess({
      cmd: fixCmd,
      logPath: path.join(logDir, '3-fix.log'),
      ...(sinkArg !== undefined ? { sink: sinkArg } : {}),
      transformer: formatClaudeStreamLine,
    });
    if (rc !== 0) {
      progress?.endStep(itemId, 'fix', 'failed');
      throw new RunFailure('fix', `claude exited ${rc}`);
    }
    progress?.endStep(itemId, 'fix', 'done');
  } else {
    progress?.endStep(itemId, 'fix', 'skipped');
  }

  // Step 4 — commit
  const message = planCommitMessage(plan);
  if (progress) {
    progress.beginStep(itemId, 'commit', `git · commit · ${plan.slug}`);
  } else {
    process.stdout.write(`\n→ [4/4] committing ${plan.slug}\n`);
  }
  if (dryRun) {
    process.stdout.write(`  (dry-run) git add -A && git commit -m "${message}"\n`);
    return;
  }
  gitAddAll();
  const commit = gitCommit(message, { capture: progress !== undefined });
  if (commit.code !== 0) {
    progress?.endStep(itemId, 'commit', 'failed');
    let detail = '';
    if (progress) {
      const captured = (commit.stderr ?? '') + (commit.stdout ?? '');
      const tail = captured
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (tail.length > 0) detail = `: ${tail[tail.length - 1]}`;
    }
    throw new RunFailure('commit', `git commit exited ${commit.code}${detail}`);
  }
  progress?.endStep(itemId, 'commit', 'done');
}

export interface RunPlanOptions {
  plan: Plan;
  dryRun: boolean;
  progress?: ProgressSink;
}

export async function runPlan(opts: RunPlanOptions): Promise<void> {
  const { plan, dryRun, progress } = opts;
  const planText = await fs.readFile(planFilePath(plan), 'utf8');
  const prs = parsePrs(planText);
  const parentLogDir = planLogDir(plan);
  await fs.mkdir(parentLogDir, { recursive: true });

  if (prs.length === 0) {
    await runPlanSingleUnit({
      plan,
      planText,
      parentLogDir,
      dryRun,
      ...(progress !== undefined ? { progress } : {}),
    });
    return;
  }

  const done = alreadyDone(plan);
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
        dryRun,
        ...(progress !== undefined ? { progress } : {}),
      });
    } catch (err) {
      if (err instanceof RunFailure) {
        progress?.endItem(pr.id, 'failed');
      }
      throw err;
    }
    progress?.endItem(pr.id, 'done');
  }
}

// REPO is re-exported for any future call site that may want it; keeps
// implicit dependency on cwd resolution centralized.
export { REPO };
