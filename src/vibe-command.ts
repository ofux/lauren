import { promises as fs } from 'node:fs';
import type { Command } from 'commander';
import { render } from 'ink';
import React from 'react';

import { type LaurenConfig, LaurenConfigError, readLaurenConfig } from './core/config.js';
import { displayPath, LAUREN_DIR, VIBE_LOCK_PATH, VIBE_PID_PATH } from './core/paths.js';
import { PlanStore } from './core/store.js';
import { type Plan, PlanNotFound, PreparingLocked } from './core/types.js';
import { type ResolvedWorkspaceRepo, resolveWorkspaceRepos } from './core/workspace.js';
import { getCurrentBranch } from './proc/git.js';
import { writePidFile } from './proc/pid.js';
import { App } from './tui/App.js';
import { WatcherRuntime } from './tui/runtime.js';
import {
  cleanupCancelledLeftoverWorktrees,
  handleCancelSignal,
  markPlanFinal,
  tryAcquireVibeLock,
  type WatcherLoopHandles,
  watcherLoop,
} from './watcher.js';
import { cleanupPlanWorktrees } from './worktree.js';

export async function finalizeCancelledImplementingPlans(
  store: PlanStore,
  plans: Plan[],
): Promise<boolean> {
  for (const plan of plans) {
    try {
      await cleanupPlanWorktrees(plan);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `error: failed to remove worktree for '${plan.slug}'; ` +
          `leaving cancellation pending: ${msg}\n`,
      );
      return false;
    }
  }

  for (const plan of plans) {
    await markPlanFinal(store, plan.slug, {
      status: 'cancelled',
      cancel_requested: false,
      cancel_intent: undefined,
      worktrees: undefined,
      pr_urls: undefined,
    });
  }
  const slugs = plans.map((p) => p.slug).join(', ');
  process.stdout.write(`cancelled '${slugs}'; removed worktree(s).\n`);
  return true;
}

export function wrongBranchRepos(
  repos: readonly ResolvedWorkspaceRepo[],
  devBranch: string,
  plans: readonly Plan[] = [],
): { repo: string; branch: string }[] {
  const checkoutBlockedRoots = new Set<string>();
  for (const plan of plans) {
    if (plan.status !== 'merge_blocked') continue;
    const block = plan.merge_block;
    if (!block) continue;
    if (block.reason === 'dirty-checkout' || block.reason === 'dirty-fast-forward') {
      checkoutBlockedRoots.add(block.parent_root);
    }
  }

  const wrongBranch: { repo: string; branch: string }[] = [];
  for (const repo of repos) {
    const branch = getCurrentBranch(repo.root);
    if (branch !== devBranch && !checkoutBlockedRoots.has(repo.root)) {
      wrongBranch.push({ repo: repo.name, branch });
    }
  }
  return wrongBranch;
}

export async function recoverImplementingPlans(
  store: PlanStore,
  implementing: Plan[],
): Promise<boolean> {
  // Crash recovery for `implementing` rows. With worktrees in play, all
  // partial work lives in the per-plan worktree (never the user's main
  // checkout), so we can always clean up safely:
  //   - cancel_requested + revert (or no intent) → tear down worktree,
  //     mark cancelled.
  //   - cancel_requested + keep → tear down nothing, mark cancelling
  //     (user resolves on the lauren/<slug> branch manually).
  //   - no cancel_requested → tear down worktree, demote to ready so
  //     the loop re-claims with a fresh worktree.
  const revertGroup = implementing.filter((p) => p.cancel_requested && p.cancel_intent !== 'keep');
  const keepGroup = implementing.filter((p) => p.cancel_requested && p.cancel_intent === 'keep');
  const orphanGroup = implementing.filter((p) => !p.cancel_requested);

  if (revertGroup.length > 0) {
    const finalized = await finalizeCancelledImplementingPlans(store, revertGroup);
    if (!finalized) return false;
  }
  for (const p of keepGroup) {
    await markPlanFinal(store, p.slug, {
      status: 'cancelling',
      cancel_requested: false,
      cancel_intent: undefined,
    });
  }
  for (const p of orphanGroup) {
    try {
      // Preserve `lauren/<slug>` so any Step commits already made on it
      // survive the resume. The stored `steps[]` records which Steps
      // already finished; deleting the branch here would silently drop
      // those commits while the resume still skipped the Steps. The
      // next run's setupPlanWorktrees reuses the existing branch.
      await cleanupPlanWorktrees(p, { keepBranches: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`warning: failed to clean orphan worktree for '${p.slug}': ${msg}\n`);
      return false;
    }
    try {
      await store.update(
        p.slug,
        {
          status: 'ready',
          started_at: null,
          finished_at: null,
          failure: null,
          worktrees: undefined,
        },
        { allowImplementing: true },
      );
    } catch (err) {
      if (!(err instanceof PlanNotFound)) throw err;
    }
  }
  return true;
}

async function cmdVibe(opts: { dryRun: boolean }): Promise<number> {
  await fs.mkdir(LAUREN_DIR, { recursive: true });
  const store = new PlanStore();

  let config: LaurenConfig;
  try {
    config = await readLaurenConfig();
  } catch (err) {
    if (err instanceof LaurenConfigError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

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
    const recovered = await recoverImplementingPlans(store, implementing);
    if (!recovered) {
      await releasePidFile().catch(() => undefined);
      await releaseVibeLock().catch(() => undefined);
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

  // Self-heal worktrees left over from a cancel-keep that the user already
  // resolved (cancelling→cancelled) while the daemon was down. The runtime
  // loop also runs this after each in-flight resolution; doing it here too
  // catches the across-restart case.
  await cleanupCancelledLeftoverWorktrees(store, await store.read());

  // Validate workspace config early so a broken `workspace_repos` setting
  // surfaces here rather than at the first merge. Dirty-tree validation now
  // happens per-plan at merge time, but wrong-branch validation remains a
  // startup guard: auto-merge is allowed to switch back to dev_branch after
  // long-running daemon drift, not silently move a user's already-wrong
  // checkout when vibe starts.
  let workspaceRepos: ResolvedWorkspaceRepo[];
  try {
    workspaceRepos = await resolveWorkspaceRepos();
  } catch (err) {
    await releasePidFile().catch(() => undefined);
    await releaseVibeLock().catch(() => undefined);
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }

  let wrongBranch: ReturnType<typeof wrongBranchRepos>;
  try {
    wrongBranch = wrongBranchRepos(workspaceRepos, config.dev_branch, await store.read());
  } catch (err) {
    await releasePidFile().catch(() => undefined);
    await releaseVibeLock().catch(() => undefined);
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: failed to read workspace branch: ${msg}\n`);
    return 1;
  }
  if (wrongBranch.length > 0) {
    await releasePidFile().catch(() => undefined);
    await releaseVibeLock().catch(() => undefined);
    const detail = wrongBranch.map((w) => `${w.repo} is on '${w.branch}'`).join(', ');
    process.stderr.write(
      `error: each workspace repo must be on '${config.dev_branch}' for lauren vibe ` +
        `to merge into it; ${detail}. Set 'dev_branch' in .lauren/config.json to override.\n`,
    );
    return 1;
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
    const result = await watcherLoop(runtime, store, config, abortController.signal, handles);
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
      // Same reasoning as the orphan-recovery path above: keep
      // `lauren/<slug>` so committed Steps survive the resume.
      try {
        await cleanupPlanWorktrees(inFlight, { keepBranches: true });
        try {
          await store.update(
            inFlight.slug,
            {
              status: 'ready',
              started_at: null,
              finished_at: null,
              failure: null,
              worktrees: undefined,
            },
            { allowImplementing: true },
          );
          process.stdout.write(
            `stopped during '${inFlight.slug}'; left as ready. Run \`lauren vibe\` to resume.\n`,
          );
        } catch {
          process.stdout.write('vibe stopped.\n');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `error: failed to clean worktree for '${inFlight.slug}'; ` +
            `left plan implementing for recovery: ${msg}\n`,
        );
        exitCode = 1;
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
      'Plan queue executor — drains .lauren/plans.json one plan at a time ' +
        '(implement → review → fix → commit). Each pipeline phase routes through the ' +
        'agent configured in .lauren/config.json (defaults: claude → codex → claude).',
    )
    .allowExcessArguments(false)
    .option('--dry-run', 'print queue and exit without running anything', false)
    .action(async (opts: { dryRun: boolean }) => {
      process.exit(await cmdVibe(opts));
    });

  return command;
}
