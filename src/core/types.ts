import path from 'node:path';
import type { CheckpointEntry } from './checkpoints.js';
import { assertPlanPathInsideLaurenPlans, DEFAULT_CONTEXT, type LaurenContext } from './paths.js';
import type { StepEntry } from './steps.js';

export type PlanStatus =
  | 'enqueued'
  | 'preparing'
  | 'ready'
  | 'implementing'
  | 'merging'
  | 'merge_blocked'
  | 'cancelling'
  | 'awaiting_human'
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
  cleanup_result?: 'done' | 'cancelled';
}

/**
 * Worktree created for a plan's implementation. `repo` is the workspace
 * repo name; `null` for single-repo plans where the only worktree covers
 * the whole repo. `parentRoot` is the path of the parent checkout from
 * which the worktree was created (where the merge will eventually run).
 */
export interface PlanWorktree {
  repo: string | null;
  path: string;
  branch: string;
  parentRoot: string;
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
  /**
   * Human checkpoints declared in the plan markdown. Absent or empty array
   * means the plan has no manual pause points. Status transitions:
   * `pending` → `done` (after the user acknowledges via the TUI). When any
   * entry is `pending` and reachable at the current Step boundary, the
   * plan transitions to `awaiting_human` and the watcher pauses.
   */
  checkpoints?: CheckpointEntry[];
  /**
   * Set when the plan is in `awaiting_human`: the id of the checkpoint
   * that triggered the pause. Cleared on acknowledgment (back to ready).
   */
  current_checkpoint_id?: string | null;
  /**
   * Worktrees created when the plan entered `implementing`. Persisted so
   * the merger and crash-recovery sweeps can find them. Cleared when the
   * worktrees are removed (success, cancel, or failure cleanup).
   */
  worktrees?: PlanWorktree[];
  /**
   * For github-pr merge mode: PR URLs keyed by worktree repo name (or the
   * literal '.' for single-repo plans). Populated when the PR is opened;
   * cleared when the plan finishes.
   */
  pr_urls?: Record<string, string>;
  /**
   * Set when status === 'merge_blocked'. Records *why* the auto-merge could
   * not run (typically a dirty parent checkout) so the TUI can surface a
   * human-readable banner and the watcher can re-test the same condition
   * on each poll. Cleared when the plan is promoted back to 'merging'.
   */
  merge_block?: PlanMergeBlock | null;
}

/**
 * Reason the auto-merge is currently paused. Stored on the plan row in
 * 'merge_blocked' status so the watcher can poll the same precondition on
 * every tick and resume automatically once it clears.
 */
export interface PlanMergeBlock {
  /**
   * Which git operation refused, and why:
   *   - `dirty-merge` — `git merge` returned "would be overwritten".
   *   - `dirty-checkout` — `git checkout dev_branch` returned the same.
   *   - `dirty-fast-forward` — after a PR merged remotely, either checkout
   *     of dev_branch or `git merge --ff-only` returned the same.
   *
   * Encodes the operation rather than a generic "dirty" so the banner can
   * say *what* git refused, and so future variants (e.g. staged-index
   * blockers, untracked-file blockers) can be distinguished if needed.
   */
  reason: 'dirty-merge' | 'dirty-checkout' | 'dirty-fast-forward';
  /** Workspace repo name (or null for single-repo plans). Mirrors PlanWorktree.repo. */
  repo: string | null;
  /** Parent checkout path that needs to be clean before the merge can resume. */
  parent_root: string;
  /**
   * Files git itself named in its refusal. The auto-resume sweep promotes
   * the row back to 'merging' only once none of these specific paths are
   * still dirty — unrelated WIP elsewhere in the repo doesn't keep the
   * pause active. Empty/absent means "no specific file list available"
   * (defensive fallback; promote unconditionally).
   */
  files?: string[];
  /** ISO timestamp of when the block was first detected (UX only). */
  detected_at: string;
  /**
   * Human-readable message displayed in the TUI banner. Stored so the
   * banner text is stable across watcher restarts without having to be
   * regenerated from {@link reason} each time.
   */
  message: string;
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

export class MergingLocked extends Error {
  readonly slug: string;
  constructor(slug: string) {
    super(`plan '${slug}' is merging and locked from non-merger mutations`);
    this.name = 'MergingLocked';
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
