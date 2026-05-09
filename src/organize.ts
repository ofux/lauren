import { promises as fs } from 'node:fs';

import { applyPlaceDecision, brainPlacePlan } from './brain.js';
import { materializePrs } from './core/prs.js';
import type { PlanStore } from './core/store.js';
import { type Plan, PlanNotFound, planFilePath } from './core/types.js';
import { ClaudeAborted } from './proc/claude.js';

export interface BrainCancelState {
  current: string | null;
  controller: AbortController | null;
}

export interface OrganizeMessage {
  level: 'info' | 'error';
  text: string;
}

export type OrganizeNotify = (msg: OrganizeMessage) => void;

/**
 * Process one enqueued plan: place it into the ready queue via the brain.
 * Idempotent — if a previous run crashed mid-placement and left the row in
 * `preparing`, this re-runs from scratch (the daemon demotes stale
 * `preparing` rows back to `enqueued` on startup).
 *
 * If the plan has `cancel_requested=true` at the start, it's removed
 * and skipped. While brain placement is running, the AbortSignal in
 * `state.controller` may abort the claude subprocess (raised when the
 * TUI signals SIGUSR2 mid-flight).
 *
 * `notify` (optional) receives human-readable progress lines; the daemon
 * surfaces them in the TUI status area. No stdout/stderr is written.
 */
export async function processEnqueuedPlan(args: {
  plan: Plan;
  store: PlanStore;
  state: BrainCancelState;
  notify?: OrganizeNotify;
}): Promise<void> {
  const { plan, store, state, notify } = args;
  const note = (level: 'info' | 'error', text: string): void => {
    notify?.({ level, text });
  };

  // Honor a cancellation that landed before we picked the plan up.
  if (plan.cancel_requested) {
    note('info', `cancelled '${plan.slug}' before preparing; removing.`);
    await store.remove(plan.slug, { allowPreparing: true }).catch((err) => {
      if (!(err instanceof PlanNotFound)) throw err;
    });
    try {
      await fs.unlink(planFilePath(plan));
    } catch {
      // ignore
    }
    return;
  }

  let body: string;
  try {
    body = await fs.readFile(planFilePath(plan), 'utf8');
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      note('error', `plan file missing for '${plan.slug}' (${plan.path}); removing.`);
      await store.remove(plan.slug, { allowPreparing: true }).catch(() => undefined);
      return;
    }
    throw err;
  }

  const controller = new AbortController();

  // Mark `preparing` BEFORE invoking claude — the TUI watches for this
  // to know which rows can still be cancelled mid-flight. Register the
  // abort controller first so a fast SIGUSR2 after the claim is not lost.
  state.current = plan.slug;
  state.controller = controller;
  try {
    await store.update(plan.slug, { status: 'preparing' }, { allowPreparing: true });
  } catch (err) {
    state.current = null;
    state.controller = null;
    if (err instanceof PlanNotFound) {
      note('info', `skipped '${plan.slug}' after losing claim.`);
      return;
    }
    throw err;
  }

  note('info', `placing '${plan.slug}' (${plan.title})…`);

  let decision: Awaited<ReturnType<typeof brainPlacePlan>>;
  try {
    decision = await brainPlacePlan(store, plan, body, controller.signal);
  } catch (err) {
    state.current = null;
    state.controller = null;
    if (err instanceof ClaudeAborted) {
      // Cancellation arrived mid-placement. Drop the row and the .md
      // file so the user sees the row disappear.
      note('info', `cancelled '${plan.slug}' during preparation.`);
      await store.remove(plan.slug, { allowPreparing: true }).catch((cleanupErr) => {
        if (!(cleanupErr instanceof PlanNotFound)) throw cleanupErr;
      });
      try {
        await fs.unlink(planFilePath(plan));
      } catch {
        // ignore
      }
      return;
    }
    // Restore status to 'enqueued' so the next loop iteration retries.
    await store
      .update(plan.slug, { status: 'enqueued' }, { allowPreparing: true })
      .catch(() => undefined);
    throw err;
  }
  state.current = null;
  state.controller = null;

  // Transition the row to `ready`. Materialize PR list from the just-read
  // markdown so the row is immediately the source of truth for what to run
  // — the executor only re-reconciles at claim time to catch later edits.
  await store.update(
    plan.slug,
    {
      status: 'ready',
      cancel_requested: false,
      prs: materializePrs(body, null),
    },
    { allowPreparing: true },
  );
  const summary = await applyPlaceDecision(store, plan, decision);
  note('info', summary);
}
