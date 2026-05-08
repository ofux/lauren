/**
 * PR-level state for multi-PR plans.
 *
 * A plan is "multi-PR" when its markdown contains one or more `### PR X.Y — title`
 * headings (see PR_HEADING_RE). Each heading becomes a {@link PrEntry} stored on
 * the plan's todo row; the executor drives them as independent units.
 *
 * Source of truth is the plan record on disk (`.lauren/plans.json`), not git
 * history. This module owns parsing the markdown into a fresh list and
 * reconciling that list with what's already stored — both happen at organize
 * time (when the brain places a plan) and at vibe claim time (when the
 * executor picks the plan up) so subsequent edits to the .md file flow into
 * the queue without losing per-PR progress.
 */

export type PrStatus = 'pending' | 'done' | 'failed' | 'orphaned';

export interface PR {
  id: string;
  title: string;
}

export interface PrEntry {
  id: string;
  title: string;
  status: PrStatus;
  /** Commit subject recorded when the PR completed. Informational. */
  commit_subject: string | null;
  started_at: string | null;
  finished_at: string | null;
}

const PR_HEADING_RE = /^### PR (\d+\.\d+) — (.+?)\s*$/;

export function parsePrs(text: string): PR[] {
  const seen = new Set<string>();
  const out: PR[] = [];
  for (const line of text.split('\n')) {
    const m = PR_HEADING_RE.exec(line);
    if (!m) continue;
    const [, id, rawTitle] = m;
    if (id === undefined || rawTitle === undefined) continue;
    const title = rawTitle.trim();
    if (seen.has(id)) {
      throw new Error(`duplicate PR id ${id} in plan`);
    }
    seen.add(id);
    out.push({ id, title });
  }
  return out;
}

function freshEntry(pr: PR): PrEntry {
  return {
    id: pr.id,
    title: pr.title,
    status: 'pending',
    commit_subject: null,
    started_at: null,
    finished_at: null,
  };
}

/**
 * Merge a freshly parsed PR list with previously stored entries.
 *
 * Iteration order follows the plan markdown. For each parsed PR, an entry
 * with the same id keeps its prior status (so resume is no-op on a PR that
 * already finished) but adopts the latest title. PRs that were in storage
 * but no longer appear in the markdown are appended after the parsed list
 * with status `orphaned` — they're preserved for visibility, never re-run.
 *
 * A PR that previously went `orphaned` and reappears is revived to `pending`.
 */
export function reconcilePrs(
  parsed: readonly PR[],
  existing: readonly PrEntry[] | null,
): PrEntry[] {
  const existingById = new Map<string, PrEntry>();
  for (const e of existing ?? []) existingById.set(e.id, e);
  const usedIds = new Set<string>();

  const result: PrEntry[] = [];
  for (const pr of parsed) {
    const prev = existingById.get(pr.id);
    if (prev !== undefined) {
      result.push({
        ...prev,
        title: pr.title,
        status: prev.status === 'orphaned' ? 'pending' : prev.status,
      });
    } else {
      result.push(freshEntry(pr));
    }
    usedIds.add(pr.id);
  }
  for (const e of existing ?? []) {
    if (!usedIds.has(e.id)) {
      result.push({ ...e, status: e.status === 'done' ? 'done' : 'orphaned' });
    }
  }
  return result;
}

/**
 * Produce the PR list to persist on a plan row given the current plan
 * markdown and the previously stored list (may be null on first sight).
 *
 * Returns `null` for single-unit plans — defined as: the markdown has no PR
 * headings AND no prior entries exist (so we don't flip a plan to single-unit
 * mode just because the user temporarily removed every PR heading mid-edit).
 */
export function materializePrs(
  planText: string,
  existing: readonly PrEntry[] | null,
): PrEntry[] | null {
  const parsed = parsePrs(planText);
  if (parsed.length === 0 && (existing === null || existing.length === 0)) return null;
  return reconcilePrs(parsed, existing);
}
