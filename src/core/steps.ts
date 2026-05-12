/**
 * Step-level state for multi-step plans.
 *
 * A plan is "multi-step" when its markdown contains one or more `### Step X.Y — title`
 * headings (see STEP_HEADING_RE). Each heading becomes a {@link StepEntry} stored on
 * the plan's todo row; the executor drives them as independent units.
 *
 * Source of truth is the plan record on disk (`.lauren/plans.json`), not git
 * history. This module owns parsing the markdown into a fresh list and
 * reconciling that list with what's already stored — both happen at organize
 * time (when the brain places a plan) and at vibe claim time (when the
 * executor picks the plan up) so subsequent edits to the .md file flow into
 * the queue without losing per-step progress.
 */

export type StepStatus = 'pending' | 'done' | 'failed' | 'orphaned';

export interface Step {
  id: string;
  title: string;
}

export interface StepEntry {
  id: string;
  title: string;
  status: StepStatus;
  /** Commit subject recorded when the step completed. Informational. */
  commit_subject: string | null;
  started_at: string | null;
  finished_at: string | null;
}

const STEP_HEADING_RE = /^### Step (\d+\.\d+) — (.+?)\s*$/;

export function parseSteps(text: string): Step[] {
  const seen = new Set<string>();
  const out: Step[] = [];
  for (const line of text.split('\n')) {
    const m = STEP_HEADING_RE.exec(line);
    if (!m) continue;
    const [, id, rawTitle] = m;
    if (id === undefined || rawTitle === undefined) continue;
    const title = rawTitle.trim();
    if (seen.has(id)) {
      throw new Error(`duplicate Step id ${id} in plan`);
    }
    seen.add(id);
    out.push({ id, title });
  }
  return out;
}

function freshEntry(step: Step): StepEntry {
  return {
    id: step.id,
    title: step.title,
    status: 'pending',
    commit_subject: null,
    started_at: null,
    finished_at: null,
  };
}

/**
 * Merge a freshly parsed Step list with previously stored entries.
 *
 * Iteration order follows the plan markdown. For each parsed Step, an entry
 * with the same id keeps its prior status (so resume is no-op on a Step that
 * already finished) but adopts the latest title. Steps that were in storage
 * but no longer appear in the markdown are appended after the parsed list
 * with status `orphaned` — they're preserved for visibility, never re-run.
 *
 * A Step that previously went `orphaned` and reappears is revived to `pending`.
 */
export function reconcileSteps(
  parsed: readonly Step[],
  existing: readonly StepEntry[] | null,
): StepEntry[] {
  const existingById = new Map<string, StepEntry>();
  for (const e of existing ?? []) existingById.set(e.id, e);
  const usedIds = new Set<string>();

  const result: StepEntry[] = [];
  for (const step of parsed) {
    const prev = existingById.get(step.id);
    if (prev !== undefined) {
      result.push({
        ...prev,
        title: step.title,
        status: prev.status === 'orphaned' ? 'pending' : prev.status,
      });
    } else {
      result.push(freshEntry(step));
    }
    usedIds.add(step.id);
  }
  for (const e of existing ?? []) {
    if (!usedIds.has(e.id)) {
      result.push({ ...e, status: e.status === 'done' ? 'done' : 'orphaned' });
    }
  }
  return result;
}

/**
 * Produce the Step list to persist on a plan row given the current plan
 * markdown and the previously stored list (may be null on first sight).
 *
 * Returns `null` for single-unit plans — defined as: the markdown has no Step
 * headings AND no prior entries exist (so we don't flip a plan to single-unit
 * mode just because the user temporarily removed every Step heading mid-edit).
 */
export function materializeSteps(
  planText: string,
  existing: readonly StepEntry[] | null,
): StepEntry[] | null {
  const parsed = parseSteps(planText);
  if (parsed.length === 0 && (existing === null || existing.length === 0)) return null;
  return reconcileSteps(parsed, existing);
}
