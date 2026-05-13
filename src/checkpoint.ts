import type { PlanStore } from './core/store.js';
import { nowIso } from './core/time.js';
import { type Plan, PlanNotFound, PlanPreconditionFailed } from './core/types.js';

export type AcknowledgeOutcome =
  | { kind: 'ok'; message: string }
  | { kind: 'noop'; message: string };

export function isAwaitingHuman(plan: Plan): boolean {
  return plan.status === 'awaiting_human';
}

/**
 * Acknowledge the pending Human Checkpoint on an `awaiting_human` plan and
 * resume the queue. Marks the checkpoint `done`, clears
 * `current_checkpoint_id`, and flips the plan back to `ready`. For a
 * single-unit plan's trailing checkpoint, the implementation commit already
 * exists, so acknowledgment advances directly to `merging`.
 */
export async function acknowledgeCheckpoint(args: {
  slug: string;
  store: PlanStore;
}): Promise<AcknowledgeOutcome> {
  const { slug, store } = args;
  const plan = await store.find(slug);
  if (plan === null) return { kind: 'noop', message: `no row for '${slug}'` };
  if (plan.status !== 'awaiting_human') {
    return {
      kind: 'noop',
      message: `'${slug}' is ${plan.status}; only awaiting_human plans accept a checkpoint ack.`,
    };
  }
  const checkpointId = plan.current_checkpoint_id ?? null;
  const existing = plan.checkpoints ?? [];
  const checkpoint = existing.find((cp) => cp.id === checkpointId) ?? null;
  const singleUnitCheckpoint =
    (plan.steps === null || plan.steps.length === 0) && checkpoint?.after_step_id === '__unit__';
  const updated = existing.map((cp) =>
    cp.id === checkpointId && cp.status === 'pending'
      ? { ...cp, status: 'done' as const, acknowledged_at: nowIso() }
      : cp,
  );
  try {
    await store.update(
      slug,
      {
        status: singleUnitCheckpoint ? 'merging' : 'ready',
        current_checkpoint_id: null,
        checkpoints: updated,
      },
      {
        precondition: (current) =>
          current.status === 'awaiting_human' &&
          (current.current_checkpoint_id ?? null) === checkpointId,
        preconditionDetail: 'row is no longer awaiting the same checkpoint',
      },
    );
  } catch (err) {
    if (err instanceof PlanNotFound) {
      return { kind: 'noop', message: `no row for '${slug}'` };
    }
    if (err instanceof PlanPreconditionFailed) {
      return {
        kind: 'noop',
        message: `'${slug}' is no longer awaiting checkpoint ${checkpointId ?? '(none)'}.`,
      };
    }
    throw err;
  }
  return { kind: 'ok', message: `acknowledged checkpoint on '${slug}'; resuming` };
}
