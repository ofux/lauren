import path from 'node:path';
import { assertPlanPathInsideLaurenPlans, DEFAULT_CONTEXT, type LaurenContext } from './paths.js';
import type { StepEntry } from './steps.js';

export type PlanStatus =
  | 'enqueued'
  | 'preparing'
  | 'ready'
  | 'implementing'
  | 'cancelling'
  | 'failed'
  | 'done'
  | 'cancelled';

/**
 * Set alongside `cancel_requested` to tell the vibe daemon how to finalize
 * a cancellation on an `implementing` plan.
 *   'revert' — abort the subprocess, revert the working tree, mark
 *              'cancelled'. This is the legacy default (absent = 'revert').
 *   'keep'   — abort the subprocess but leave the working tree untouched.
 *              The plan is marked 'cancelling' and the daemon pauses until
 *              the user manually resolves it (commit/stash + flip status
 *              to 'cancelled').
 */
export type CancelIntent = 'revert' | 'keep';

export interface PlanFailure {
  phase: string;
  step_id: string | null;
  message: string;
}

export interface Plan {
  slug: string;
  title: string;
  path: string;
  target_repos: string[];
  status: PlanStatus;
  cancel_requested: boolean;
  /**
   * When `cancel_requested` is true on an `implementing` plan, this field
   * encodes whether the daemon should revert the working tree before
   * finalizing. Absent / null = 'revert' (legacy default).
   */
  cancel_intent?: CancelIntent;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  failure: PlanFailure | null;
  /**
   * Per-step state for multi-step plans. `null` means single-unit (no Step
   * headings in the markdown) or not yet materialized. The list is the
   * authoritative source for what to run and what's already done — the
   * executor does not consult git history.
   */
  steps: StepEntry[] | null;
}

export interface TodoFile {
  version: 2;
  plans: Plan[];
}

export const SCHEMA_VERSION = 2 as const;

export function planFilePath(plan: Plan, context: LaurenContext = DEFAULT_CONTEXT): string {
  return assertPlanPathInsideLaurenPlans(plan.path, context);
}

export function planLogDir(plan: Plan, context: LaurenContext = DEFAULT_CONTEXT): string {
  return path.join(context.logRoot, plan.slug);
}

export class SlugCollision extends Error {
  readonly slug: string;
  constructor(slug: string) {
    super(`slug collision: ${slug}`);
    this.name = 'SlugCollision';
    this.slug = slug;
  }
}

export class ImplementingLocked extends Error {
  readonly slug: string;
  constructor(slug: string) {
    super(`plan '${slug}' is implementing and locked from non-executor mutations`);
    this.name = 'ImplementingLocked';
    this.slug = slug;
  }
}

export class PreparingLocked extends Error {
  readonly slug: string;
  constructor(slug: string) {
    super(`plan '${slug}' is preparing and locked from non-brain mutations`);
    this.name = 'PreparingLocked';
    this.slug = slug;
  }
}

export class PlanNotReady extends Error {
  readonly slug: string;
  readonly status: PlanStatus;
  constructor(slug: string, status: PlanStatus) {
    super(`plan '${slug}' is ${status}, not ready`);
    this.name = 'PlanNotReady';
    this.slug = slug;
    this.status = status;
  }
}

export class PlanNotFound extends Error {
  readonly slug: string;
  constructor(slug: string) {
    super(`plan not found: ${slug}`);
    this.name = 'PlanNotFound';
    this.slug = slug;
  }
}

export class PlanSelfMerge extends Error {
  readonly slug: string;
  constructor(slug: string) {
    super(`plan '${slug}' cannot be merged into itself`);
    this.name = 'PlanSelfMerge';
    this.slug = slug;
  }
}

export class PlanPreconditionFailed extends Error {
  readonly slug: string;
  constructor(slug: string, detail: string) {
    super(`plan '${slug}' failed update precondition: ${detail}`);
    this.name = 'PlanPreconditionFailed';
    this.slug = slug;
  }
}
