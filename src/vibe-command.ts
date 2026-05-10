import { promises as fs } from 'node:fs';
import type { Command } from 'commander';
import { render } from 'ink';
import React from 'react';

import { displayPath, LAUREN_DIR, VIBE_LOCK_PATH, VIBE_PID_PATH } from './core/paths.js';
import { PlanStore } from './core/store.js';
import { type Plan, PlanNotFound, PreparingLocked } from './core/types.js';
import {
  formatRepoList,
  type ResolvedWorkspaceRepo,
  resolveWorkspaceRepos,
} from './core/workspace.js';
import { revertWorkingTree, workingTreeDirty } from './proc/git.js';
import { writePidFile } from './proc/pid.js';
import { App } from './tui/App.js';
import { WatcherRuntime } from './tui/runtime.js';
import {
  handleCancelSignal,
  markPlanFinal,
  tryAcquireVibeLock,
  type WatcherLoopHandles,
  watcherLoop,
} from './watcher.js';

async function resolveCancelledPlanRepos(plans: readonly Plan[]): Promise<ResolvedWorkspaceRepo[]> {
  const reposByRoot = new Map<string, ResolvedWorkspaceRepo>();
  for (const plan of plans) {
    const repos = await resolveWorkspaceRepos(plan.target_repos);
    for (const repo of repos) {
      if (!reposByRoot.has(repo.root)) reposByRoot.set(repo.root, repo);
    }
  }
  return Array.from(reposByRoot.values());
}

export async function finalizeCancelledImplementingPlans(
  store: PlanStore,
  plans: Plan[],
): Promise<boolean> {
  try {
    const repos = await resolveCancelledPlanRepos(plans);
    for (const repo of repos) {
      revertWorkingTree(repo.root);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `error: failed to revert working tree; leaving cancellation pending: ${msg}\n`,
    );
    return false;
  }

  for (const plan of plans) {
    await markPlanFinal(store, plan.slug, { status: 'cancelled', cancel_requested: false });
  }
  const slugs = plans.map((p) => p.slug).join(', ');
  process.stdout.write(`cancelled '${slugs}'; reverted working tree.\n`);
  return true;
}

function dirtyRepos(repos: readonly ResolvedWorkspaceRepo[]): ResolvedWorkspaceRepo[] {
  return repos.filter((repo) => workingTreeDirty(repo.root));
}

async function cmdVibe(opts: { dryRun: boolean }): Promise<number> {
  await fs.mkdir(LAUREN_DIR, { recursive: true });
  const store = new PlanStore();

  if (opts.dryRun) {
    const plans = await store.read();
    process.stdout.write(`Queue (${plans.length} plan(s)):\n`);
    for (const p of plans) {
      process.stdout.write(`  [${p.status}] ${p.slug} — ${p.title}\n`);
    }
    const enqueued = plans.filter((p) => p.status === 'enqueued');
    const ready = plans.filter((p) => p.status === 'ready');
    const implementing = plans.filter((p) => p.status === 'implementing');
    const cancelling = plans.filter((p) => p.status === 'cancelling');
    const failed = plans.filter((p) => p.status === 'failed');
    if (implementing.length > 0) {
      process.stdout.write(
        `\nWould refuse to start: implementing = ${JSON.stringify(implementing.map((p) => p.slug))}\n`,
      );
    } else if (cancelling.length > 0) {
      process.stdout.write(
        `\nWould pause: cancelling = ${JSON.stringify(cancelling.map((p) => p.slug))}\n`,
      );
    } else if (enqueued.length > 0) {
      process.stdout.write(`\nWould drain enqueued plans first (${enqueued.length} plan(s)).\n`);
    } else if (failed.length > 0) {
      process.stdout.write(
        `\nWould pause: failed = ${JSON.stringify(failed.map((p) => p.slug))}\n`,
      );
    } else if (ready.length > 0) {
      process.stdout.write(`\nWould run next: ${ready[0]!.slug}\n`);
    } else {
      process.stdout.write('\nWould idle (empty queue).\n');
    }
    return 0;
  }

  // Whole-process lock: prevents two vibe watchers from claiming
  // different plans in the same repo and clobbering each other's working
  // tree. Held for the lifetime of this process; released in finally.
  const releaseVibeLock = await tryAcquireVibeLock();
  if (releaseVibeLock === null) {
    process.stderr.write(
      `error: another vibe watcher is already running in this repo ` +
        `(lock: ${displayPath(VIBE_LOCK_PATH)}).\n`,
    );
    return 1;
  }

  const releasePidFile = await writePidFile(VIBE_PID_PATH, 'lauren-vibe');

  const initialPlans = await store.read();
  const implementing = initialPlans.filter((p) => p.status === 'implementing');
  if (implementing.length > 0) {
    const cancellable = implementing.filter((p) => p.cancel_requested);
    if (cancellable.length === implementing.length) {
      // Honor cancel_requested set while the prior process was down. Split
      // by intent: revert-intent plans get the working tree reverted and
      // are marked 'cancelled' (today's behavior); keep-intent plans are
      // demoted to 'cancelling' inline (no tree change) and the loop will
      // pause on them.
      const revertGroup = cancellable.filter((p) => p.cancel_intent !== 'keep');
      const keepGroup = cancellable.filter((p) => p.cancel_intent === 'keep');
      if (revertGroup.length > 0) {
        const finalized = await finalizeCancelledImplementingPlans(store, revertGroup);
        if (!finalized) {
          await releasePidFile().catch(() => undefined);
          await releaseVibeLock().catch(() => undefined);
          return 1;
        }
      }
      for (const p of keepGroup) {
        await markPlanFinal(store, p.slug, {
          status: 'cancelling',
          cancel_requested: false,
          cancel_intent: undefined,
        });
      }
      if (keepGroup.length === 0) {
        await releasePidFile().catch(() => undefined);
        await releaseVibeLock().catch(() => undefined);
        return 0;
      }
      // Fall through: keep-intent plans are now 'cancelling'; the loop will
      // enter the paused state on them.
    } else {
      await releasePidFile().catch(() => undefined);
      await releaseVibeLock();
      const slugs = implementing.map((p) => p.slug).join(', ');
      process.stderr.write(
        `error: plan(s) ${slugs} marked implementing (likely from a crashed run). ` +
          `Inspect with \`git status\`, clean the working tree, then manually set ` +
          `\`status: "ready"\` (and clear \`started_at\`/\`failure\`) for each row in ` +
          `\`.lauren/plans.json\`.\n`,
      );
      return 1;
    }
  }

  // Recover from a crashed run that left rows in `preparing`. Demote them
  // back to `enqueued` so the drain loop can place them fresh on this run.
  // Honors cancel_requested set while the prior process was down.
  const stalePreparing = (await store.read()).filter((p) => p.status === 'preparing');
  for (const plan of stalePreparing) {
    try {
      await store.update(plan.slug, { status: 'enqueued' }, { allowPreparing: true });
    } catch (err) {
      if (!(err instanceof PreparingLocked) && !(err instanceof PlanNotFound)) {
        throw err;
      }
    }
  }

  // If any plan is 'cancelling', the working tree is expected to be dirty
  // (the user kept the partial work). Skip the dirty-tree refusal — the
  // watcher loop will enter the paused state and tell the user what to do.
  const hasCancelling = (await store.read()).some((p) => p.status === 'cancelling');
  if (!hasCancelling) {
    let dirty: ResolvedWorkspaceRepo[];
    try {
      dirty = dirtyRepos(await resolveWorkspaceRepos());
    } catch (err) {
      await releasePidFile().catch(() => undefined);
      await releaseVibeLock().catch(() => undefined);
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: ${msg}\n`);
      return 1;
    }
    if (dirty.length > 0) {
      await releasePidFile().catch(() => undefined);
      await releaseVibeLock().catch(() => undefined);
      process.stderr.write(
        `error: working tree is dirty in ${formatRepoList(
          dirty,
        )}. Commit or stash changes before running lauren vibe.\n`,
      );
      return 1;
    }
  }

  process.stdout.write('✨ vibe watcher started. Ctrl-C to stop.\n\n');

  const runtime = new WatcherRuntime();
  const abortController = new AbortController();
  const handles: WatcherLoopHandles = {
    current: { slug: null },
    phase: { value: 'idle' },
    cancelController: { ref: null },
    brainState: { current: null, controller: null },
  };

  const inkApp = render(React.createElement(App, { runtime }), {
    exitOnCtrlC: false,
  });

  let interrupts = 0;
  const sigint = (): void => {
    interrupts += 1;
    if (interrupts === 1) {
      abortController.abort();
      process.stderr.write('\n(Ctrl-C received — finishing current step; press again to force.)\n');
      return;
    }
    process.stderr.write('\n(forced exit; child processes may still be running)\n');
    process.exit(130);
  };
  process.on('SIGINT', sigint);

  // SIGUSR2 = TUI requests cancellation of the in-flight plan. Dispatch by
  // phase: in 'organizing', abort the brain subprocess; in 'implementing',
  // abort the executor. Either way the loop drops the cancelled row and
  // continues. See handleCancelSignal for the race-handling details.
  process.on('SIGUSR2', () => {
    void handleCancelSignal(store, handles);
  });

  let inFlight: Plan | null = null;
  let cancelledSlug: string | null = null;
  let loopError: unknown = null;
  try {
    const result = await watcherLoop(runtime, store, abortController.signal, handles);
    inFlight = result.inFlight;
    cancelledSlug = result.cancelledSlug;
  } catch (err) {
    loopError = err;
  } finally {
    process.off('SIGINT', sigint);
    inkApp.unmount();
    await inkApp.waitUntilExit().catch(() => undefined);
  }

  if (loopError !== null) {
    await releasePidFile().catch(() => undefined);
    await releaseVibeLock().catch(() => undefined);
    throw loopError;
  }

  process.stdout.write('\n');
  let exitCode = 0;
  try {
    if (cancelledSlug !== null && inFlight !== null) {
      // Per-plan cancellation: revert any partial work and finalize.
      const finalized = await finalizeCancelledImplementingPlans(store, [inFlight]);
      exitCode = finalized ? 0 : 1;
    } else if (inFlight !== null) {
      try {
        await store.update(
          inFlight.slug,
          {
            status: 'ready',
            started_at: null,
            finished_at: null,
            failure: null,
          },
          { allowImplementing: true },
        );
        process.stdout.write(
          `stopped during '${inFlight.slug}'; left as ready. ` +
            `Run \`lauren vibe\` to resume (clean the working tree first).\n`,
        );
      } catch {
        process.stdout.write('vibe stopped.\n');
      }
    } else {
      process.stdout.write('vibe stopped.\n');
    }
  } finally {
    await releasePidFile().catch(() => undefined);
    await releaseVibeLock().catch(() => undefined);
  }
  return exitCode;
}

export function configureVibeCommand(command: Command): Command {
  command
    .description(
      'Plan queue executor — drains .lauren/plans.json one plan at a time (claude → codex → claude → commit).',
    )
    .allowExcessArguments(false)
    .option('--dry-run', 'print queue and exit without running anything', false)
    .action(async (opts: { dryRun: boolean }) => {
      process.exit(await cmdVibe(opts));
    });

  return command;
}
