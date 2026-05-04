#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';

import { displayPath, LAUREN_DIR } from '../core/paths.js';
import { TodoStore } from '../core/store.js';
import { nowIso } from '../core/time.js';
import {
  InProgressLocked,
  type Plan,
  type PlanFailure,
  PlanNotFound,
  planFilePath,
} from '../core/types.js';
import { parsePrs, RunFailure, runPlan } from '../executor.js';
import { workingTreeDirty } from '../proc/git.js';
import { App } from '../tui/App.js';
import { newPlanRuntimeState, type PlanItem, WatcherRuntime } from '../tui/runtime.js';

const IDLE_POLL_SECONDS = 3.0;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function planFileExists(plan: Plan): Promise<boolean> {
  try {
    await fs.access(planFilePath(plan));
    return true;
  } catch {
    return false;
  }
}

async function vibeWatcherLoop(
  runtime: WatcherRuntime,
  store: TodoStore,
  signal: AbortSignal,
): Promise<{ inFlight: Plan | null }> {
  let inFlight: Plan | null = null;
  while (!signal.aborted) {
    const plans = await store.read();

    const failed = plans.find((p) => p.status === 'failed');
    if (failed) {
      runtime.setPaused(plans, failed);
      await sleep(IDLE_POLL_SECONDS * 1000, signal);
      continue;
    }

    const pending = plans.filter((p) => p.status === 'pending');
    if (pending.length === 0) {
      runtime.setIdle(plans);
      await sleep(IDLE_POLL_SECONDS * 1000, signal);
      continue;
    }

    const next = pending[0]!;

    if (!(await planFileExists(next))) {
      const failure: PlanFailure = {
        step: 'implement',
        pr_id: null,
        message: `plan file missing: ${next.path}`,
      };
      try {
        await store.update(next.slug, {
          status: 'failed',
          finished_at: nowIso(),
          failure,
        });
      } catch (err) {
        if (!(err instanceof InProgressLocked) && !(err instanceof PlanNotFound)) {
          throw err;
        }
      }
      continue;
    }

    let claimed: Plan;
    try {
      claimed = await store.update(next.slug, {
        status: 'in_progress',
        started_at: nowIso(),
        finished_at: null,
        failure: null,
      });
    } catch (err) {
      if (err instanceof InProgressLocked || err instanceof PlanNotFound) {
        continue;
      }
      throw err;
    }
    inFlight = claimed;

    try {
      const planText = await fs.readFile(planFilePath(claimed), 'utf8');
      const prs = parsePrs(planText);
      const items: PlanItem[] =
        prs.length > 0
          ? prs.map((pr) => ({ id: pr.id, title: pr.title }))
          : [{ id: claimed.slug, title: claimed.title }];
      const planProgress = newPlanRuntimeState({
        items,
        planTitle: claimed.title,
      });
      runtime.setRunning(await store.read(), claimed, planProgress);
      await runPlan({ plan: claimed, dryRun: false, progress: runtime });
    } catch (err) {
      const failure: PlanFailure =
        err instanceof RunFailure
          ? { step: err.step, pr_id: err.prId, message: err.message }
          : {
              step: 'unknown',
              pr_id: null,
              message: `unexpected error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
            };
      try {
        await store.update(
          claimed.slug,
          { status: 'failed', finished_at: nowIso(), failure },
          { allowInProgress: true },
        );
      } catch (e) {
        if (!(e instanceof InProgressLocked) && !(e instanceof PlanNotFound)) {
          throw e;
        }
      }
      inFlight = null;
      continue;
    }

    // Clear in_flight before marking done so an abort in the window below
    // can't demote a finished plan back to pending.
    inFlight = null;
    try {
      await store.update(
        claimed.slug,
        { status: 'done', finished_at: nowIso() },
        { allowInProgress: true },
      );
    } catch (err) {
      if (!(err instanceof InProgressLocked) && !(err instanceof PlanNotFound)) {
        throw err;
      }
    }
  }

  return { inFlight };
}

async function cmdVibe(opts: { dryRun: boolean }): Promise<number> {
  await fs.mkdir(LAUREN_DIR, { recursive: true });
  const store = new TodoStore();

  if (opts.dryRun) {
    const plans = await store.read();
    process.stdout.write(`Queue (${plans.length} plan(s)):\n`);
    for (const p of plans) {
      process.stdout.write(`  [${p.status}] ${p.slug} — ${p.title}\n`);
    }
    const pending = plans.filter((p) => p.status === 'pending');
    const inProgress = plans.filter((p) => p.status === 'in_progress');
    const failed = plans.filter((p) => p.status === 'failed');
    if (inProgress.length > 0) {
      process.stdout.write(
        `\nWould refuse to start: in_progress = ${JSON.stringify(inProgress.map((p) => p.slug))}\n`,
      );
    } else if (failed.length > 0) {
      process.stdout.write(
        `\nWould pause: failed = ${JSON.stringify(failed.map((p) => p.slug))}\n`,
      );
    } else if (pending.length > 0) {
      process.stdout.write(`\nWould run next: ${pending[0]!.slug}\n`);
    } else {
      process.stdout.write('\nWould idle (empty queue).\n');
    }
    return 0;
  }

  if (workingTreeDirty()) {
    process.stderr.write(
      'error: working tree is dirty. Commit or stash changes before running vibe.\n',
    );
    return 1;
  }

  const initialPlans = await store.read();
  const inProgress = initialPlans.filter((p) => p.status === 'in_progress');
  if (inProgress.length > 0) {
    const slugs = inProgress.map((p) => p.slug).join(', ');
    process.stderr.write(
      `error: plan(s) ${slugs} marked in_progress (likely from a crashed run). ` +
        `Inspect with \`git status\`, clean the working tree, then run ` +
        `\`vibe retry <slug>\` to retry from scratch.\n`,
    );
    return 1;
  }

  process.stdout.write('✨ vibe watcher started. Ctrl-C to stop.\n\n');

  const runtime = new WatcherRuntime();
  const abortController = new AbortController();

  const inkApp = render(React.createElement(App, { runtime }), {
    exitOnCtrlC: false,
  });

  const sigint = (): void => {
    abortController.abort();
  };
  process.once('SIGINT', sigint);

  let inFlight: Plan | null = null;
  try {
    const result = await vibeWatcherLoop(runtime, store, abortController.signal);
    inFlight = result.inFlight;
  } finally {
    process.removeListener('SIGINT', sigint);
    inkApp.unmount();
    await inkApp.waitUntilExit().catch(() => undefined);
  }

  process.stdout.write('\n');
  if (inFlight !== null) {
    try {
      await store.update(
        inFlight.slug,
        {
          status: 'pending',
          started_at: null,
          finished_at: null,
          failure: null,
        },
        { allowInProgress: true },
      );
      process.stdout.write(
        `stopped during '${inFlight.slug}'; left as pending. ` +
          `Run \`vibe\` to resume (clean the working tree first).\n`,
      );
    } catch {
      process.stdout.write('vibe stopped.\n');
    }
  } else {
    process.stdout.write('vibe stopped.\n');
  }
  return 0;
}

async function cmdRetry(slug: string): Promise<number> {
  const store = new TodoStore();
  const plan = await store.find(slug);
  if (plan === null) {
    process.stderr.write(`error: slug not found: ${slug}\n`);
    return 1;
  }
  if (plan.status !== 'failed' && plan.status !== 'in_progress') {
    process.stderr.write(
      `error: plan '${slug}' is '${plan.status}', not failed or in_progress. ` +
        `Only failed or in_progress plans can be retried.\n`,
    );
    return 1;
  }
  await store.update(
    slug,
    {
      status: 'pending',
      started_at: null,
      finished_at: null,
      failure: null,
    },
    { allowInProgress: true },
  );
  process.stdout.write(`retrying '${slug}' — back to pending\n`);
  return 0;
}

async function cmdRm(slug: string, opts: { purge: boolean }): Promise<number> {
  const store = new TodoStore();
  let plan: Plan;
  try {
    plan = await store.remove(slug);
  } catch (err) {
    if (err instanceof InProgressLocked) {
      process.stderr.write(
        `error: plan '${slug}' is in_progress and cannot be removed. ` +
          `Run \`vibe retry ${slug}\` first if it is genuinely stuck, ` +
          `then try again.\n`,
      );
      return 1;
    }
    if (err instanceof PlanNotFound) {
      process.stderr.write(`error: slug not found: ${slug}\n`);
      return 1;
    }
    throw err;
  }
  process.stdout.write(`removed '${slug}'\n`);
  if (opts.purge) {
    try {
      await fs.unlink(planFilePath(plan));
      process.stdout.write(`deleted ${displayPath(planFilePath(plan))}\n`);
    } catch (err) {
      if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }
  return 0;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('vibe')
    .description(
      'Plan queue executor — drains .lauren/todo.json one plan at a time (claude → codex → claude → commit).',
    )
    .version('0.1.0');

  program
    .option('--dry-run', 'print queue and exit without running anything', false)
    .action(async (opts: { dryRun: boolean }) => {
      // Default action — only fires when no subcommand was given.
      process.exit(await cmdVibe(opts));
    });

  program
    .command('retry')
    .description('reset a failed or in-progress plan back to pending')
    .argument('<slug>')
    .action(async (slug: string) => {
      process.exit(await cmdRetry(slug));
    });

  program
    .command('rm')
    .description('remove a plan from the queue (manual)')
    .argument('<slug>')
    .option('--purge', 'also delete the .md file', false)
    .action(async (slug: string, opts: { purge: boolean }) => {
      process.exit(await cmdRm(slug, opts));
    });

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
