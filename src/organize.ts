import { promises as fs } from 'node:fs';

import { applyPlaceDecision, brainPlacePlan } from './brain.js';
import type { InboxStore } from './core/inbox.js';
import { materializePrs } from './core/prs.js';
import type { TodoStore } from './core/store.js';
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
 * Process one inbox plan: place it into the todo via the brain, then drop
 * it from the inbox. Idempotent — handles the case where a previous run
 * crashed between todoStore.add and inboxStore.remove.
 *
 * If the inbox plan has cancel_requested=true at the start, the plan is
 * removed from the inbox and skipped. While brain placement is running,
 * the AbortSignal in `state.controller` may abort the claude subprocess
 * (raised when the TUI signals SIGUSR2 mid-flight).
 *
 * `notify` (optional) receives human-readable progress lines; the daemon
 * surfaces them in the TUI status area. No stdout/stderr is written.
 */
export async function processInboxPlan(args: {
  plan: Plan;
  todoStore: TodoStore;
  inboxStore: InboxStore;
  state: BrainCancelState;
  notify?: OrganizeNotify;
}): Promise<void> {
  const { plan, todoStore, inboxStore, state, notify } = args;
  const note = (level: 'info' | 'error', text: string): void => {
    notify?.({ level, text });
  };

  // Crash-recovery shortcut: if the plan is already in todo, a previous
  // iteration placed it but failed to clean up the inbox. Just remove it.
  const existing = await todoStore.find(plan.slug);
  if (existing !== null) {
    note(
      'info',
      `'${plan.slug}' already in todo (status=${existing.status}); removing from inbox.`,
    );
    await inboxStore.remove(plan.slug, { allowPreparing: true }).catch((err) => {
      if (!(err instanceof PlanNotFound)) throw err;
    });
    return;
  }

  // Honor a cancellation that landed before we picked the plan up.
  if (plan.cancel_requested) {
    note('info', `cancelled '${plan.slug}' before preparing; removing.`);
    await inboxStore.remove(plan.slug, { allowPreparing: true }).catch((err) => {
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
      note('error', `plan file missing for '${plan.slug}' (${plan.path}); removing from inbox.`);
      await inboxStore.remove(plan.slug, { allowPreparing: true }).catch(() => undefined);
      return;
    }
    throw err;
  }

  const controller = new AbortController();

  // Mark `preparing` BEFORE invoking claude — the TUI watches for this
  // to know which inbox plans can still be cancelled mid-flight. Register
  // the abort controller first so a fast SIGUSR2 after the claim is not lost.
  state.current = plan.slug;
  state.controller = controller;
  try {
    await inboxStore.update(plan.slug, { status: 'preparing' }, { allowPreparing: true });
  } catch (err) {
    state.current = null;
    state.controller = null;
    if (err instanceof PlanNotFound) {
      note('info', `skipped '${plan.slug}' after losing inbox claim.`);
      return;
    }
    throw err;
  }

  note('info', `placing '${plan.slug}' (${plan.title})…`);

  let decision: Awaited<ReturnType<typeof brainPlacePlan>>;
  try {
    decision = await brainPlacePlan(todoStore, plan, body, controller.signal);
  } catch (err) {
    state.current = null;
    state.controller = null;
    if (err instanceof ClaudeAborted) {
      // Cancellation arrived mid-placement. Drop the plan and the .md
      // file so the user sees the row disappear.
      note('info', `cancelled '${plan.slug}' during preparation.`);
      await inboxStore.remove(plan.slug, { allowPreparing: true }).catch((cleanupErr) => {
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
    await inboxStore
      .update(plan.slug, { status: 'enqueued' }, { allowPreparing: true })
      .catch(() => undefined);
    throw err;
  }
  state.current = null;
  state.controller = null;

  // Add to todo as `ready`. Strip `preparing` status before insert.
  // Materialize PR list from the just-read markdown so the todo row is
  // immediately the source of truth for what to run — the executor only
  // re-reconciles at vibe claim time to catch later edits.
  const readyPlan: Plan = {
    ...plan,
    status: 'ready',
    cancel_requested: false,
    prs: materializePrs(body, null),
  };
  await todoStore.add(readyPlan);
  const summary = await applyPlaceDecision(todoStore, readyPlan, decision);
  note('info', summary);
  await inboxStore.remove(plan.slug, { allowPreparing: true }).catch((err) => {
    if (!(err instanceof PlanNotFound)) throw err;
  });
}
