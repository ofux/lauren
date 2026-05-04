import path from 'node:path';
import { LOG_ROOT, REPO } from './paths.js';

export type PlanStatus = 'pending' | 'in_progress' | 'done' | 'failed';

export const PLAN_STATUSES: readonly PlanStatus[] = [
  'pending',
  'in_progress',
  'done',
  'failed',
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
  status: PlanStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  failure: PlanFailure | null;
}

export interface TodoFile {
  version: 1;
  plans: Plan[];
}

export const SCHEMA_VERSION = 1 as const;

export function planFilePath(plan: Plan): string {
  return path.isAbsolute(plan.path) ? plan.path : path.join(REPO, plan.path);
}

export function planLogDir(plan: Plan): string {
  return path.join(LOG_ROOT, plan.slug);
}

export class SlugCollision extends Error {
  readonly slug: string;
  constructor(slug: string) {
    super(`slug collision: ${slug}`);
    this.name = 'SlugCollision';
    this.slug = slug;
  }
}

export class InProgressLocked extends Error {
  readonly slug: string;
  constructor(slug: string) {
    super(`plan '${slug}' is in_progress and locked from non-executor mutations`);
    this.name = 'InProgressLocked';
    this.slug = slug;
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
