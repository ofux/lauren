import path from 'node:path';
import { assertPlanPathInsideLaurenPlans, DEFAULT_CONTEXT, type LaurenContext } from './paths.js';
import { migratePrEntry, type PrEntry } from './prs.js';

export type PlanStatus =
  | 'enqueued'
  | 'preparing'
  | 'ready'
  | 'implementing'
  | 'failed'
  | 'done'
  | 'cancelled';

export const PLAN_STATUSES: readonly PlanStatus[] = [
  'enqueued',
  'preparing',
  'ready',
  'implementing',
  'failed',
  'done',
  'cancelled',
] as const;

export interface PlanFailure {
  step: string;
  pr_id: string | null;
  message: string;
}

export interface Plan {
  slug: string;
  title: string;
  path: string;
  target_repos: string[];
  status: PlanStatus;
  cancel_requested: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  failure: PlanFailure | null;
  /**
   * Per-PR state for multi-PR plans. `null` means single-unit (no PR
   * headings in the markdown) or not yet materialized. The list is the
   * authoritative source for what to run and what's already done — the
   * executor does not consult git history.
   */
  prs: PrEntry[] | null;
}

export interface TodoFile {
  version: 1;
  plans: Plan[];
}

export const SCHEMA_VERSION = 1 as const;

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

/**
 * Coerce a plan record loaded from disk into the current schema.
 * Adds defaults for fields introduced after v1 (kept under SCHEMA_VERSION 1
 * for forward-compat) and migrates legacy status values to the new union.
 *
 * The status migration is store-specific (inbox 'pending' → 'enqueued';
 * todo 'pending' → 'ready', 'in_progress' → 'implementing'). Pass which
 * surface this plan came from via `surface`.
 */
export function migratePlanRecord(raw: unknown, surface: 'inbox' | 'todo'): Plan {
  const r = raw as Record<string, unknown>;
  const rawStatus = typeof r.status === 'string' ? r.status : '';
  let status: PlanStatus;
  if (surface === 'inbox') {
    status = rawStatus === 'pending' ? 'enqueued' : (rawStatus as PlanStatus);
  } else {
    if (rawStatus === 'pending') status = 'ready';
    else if (rawStatus === 'in_progress') status = 'implementing';
    else status = rawStatus as PlanStatus;
  }
  return {
    slug: String(r.slug ?? ''),
    title: String(r.title ?? ''),
    path: String(r.path ?? ''),
    target_repos: Array.isArray(r.target_repos)
      ? r.target_repos.filter((repo): repo is string => typeof repo === 'string')
      : [],
    status,
    cancel_requested: r.cancel_requested === true,
    created_at: String(r.created_at ?? ''),
    started_at: typeof r.started_at === 'string' ? r.started_at : null,
    finished_at: typeof r.finished_at === 'string' ? r.finished_at : null,
    failure:
      r.failure && typeof r.failure === 'object'
        ? {
            step: String((r.failure as Record<string, unknown>).step ?? 'unknown'),
            pr_id:
              typeof (r.failure as Record<string, unknown>).pr_id === 'string'
                ? ((r.failure as Record<string, unknown>).pr_id as string)
                : null,
            message: String((r.failure as Record<string, unknown>).message ?? ''),
          }
        : null,
    prs: migratePrs(r.prs),
  };
}

function migratePrs(raw: unknown): PrEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PrEntry[] = [];
  for (const item of raw) {
    const entry = migratePrEntry(item);
    if (entry !== null) out.push(entry);
  }
  return out;
}
