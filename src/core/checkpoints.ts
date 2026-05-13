/**
 * Human-checkpoint state for plans that pause for manual work.
 *
 * A "human checkpoint" is a rare `### Human Checkpoint — <title>` section in a
 * plan that references an HTML sidecar file with instructions the user must
 * carry out by hand (configure a hosted dashboard, flip a feature flag, run a
 * smoke test, etc.). Checkpoints sit at Step boundaries; the executor commits
 * the last Step, transitions the plan to `awaiting_human`, and the watcher
 * pauses until the user acknowledges via the TUI.
 *
 * Source of truth is the plan record on disk (`.lauren/plans.json`). The
 * markdown is re-parsed at organize time and reconciled with stored state so
 * that brain merges that rewrite the plan body don't lose previously
 * acknowledged checkpoints.
 *
 * `after_step_id` discriminates placement:
 *   - `null`     — runs before the very first Step (multi-step plans only).
 *   - `'<id>'`   — runs after the matching Step's commit (multi-step plans).
 *   - `'__unit__'` — runs after the single implementation commit (single-unit
 *                  plans). Single-unit plans accept at most one trailing
 *                  checkpoint; leading or multiple checkpoints are rejected.
 */

export type CheckpointStatus = 'pending' | 'done';

export interface ParsedCheckpoint {
  id: string;
  title: string;
  html_path: string;
  after_step_id: string | null;
}

export interface CheckpointEntry {
  id: string;
  title: string;
  /** Repo-relative path to the HTML sidecar file. */
  html_path: string;
  /**
   * Step id this checkpoint follows, or `null` for a leading checkpoint, or
   * `'__unit__'` for a single-unit plan's trailing checkpoint.
   */
  after_step_id: string | null;
  status: CheckpointStatus;
  acknowledged_at?: string | null;
}

export const SINGLE_UNIT_AFTER = '__unit__' as const;

function freshEntry(parsed: ParsedCheckpoint): CheckpointEntry {
  return {
    id: parsed.id,
    title: parsed.title,
    html_path: parsed.html_path,
    after_step_id: parsed.after_step_id,
    status: 'pending',
    acknowledged_at: null,
  };
}

/**
 * Merge freshly parsed checkpoints with previously stored ones. Matches by
 * `html_path` since the sidecar location is the most stable identifier (the
 * markdown title is more likely to be edited during a brain merge than the
 * underlying HTML file's filename).
 *
 * Matched: prior status + acknowledged_at preserved; title / after_step_id
 * adopt the latest parsed values.
 * Unmatched parsed: fresh `pending`.
 * Unmatched stored: dropped — there's no `orphaned` checkpoint state, since a
 * checkpoint that no longer appears in the markdown has nothing to replay.
 */
export function reconcileCheckpoints(
  parsed: readonly ParsedCheckpoint[],
  existing: readonly CheckpointEntry[] | null,
): CheckpointEntry[] {
  const existingByPath = new Map<string, CheckpointEntry>();
  for (const e of existing ?? []) existingByPath.set(e.html_path, e);
  return parsed.map((p) => {
    const prev = existingByPath.get(p.html_path);
    if (prev !== undefined) {
      return {
        ...prev,
        id: p.id,
        title: p.title,
        after_step_id: p.after_step_id,
        html_path: p.html_path,
      };
    }
    return freshEntry(p);
  });
}

export function nextPendingCheckpointAfter(
  checkpoints: readonly CheckpointEntry[] | undefined,
  afterStepId: string | null,
): CheckpointEntry | null {
  if (!checkpoints) return null;
  for (const cp of checkpoints) {
    if (cp.status !== 'pending') continue;
    if (cp.after_step_id === afterStepId) return cp;
  }
  return null;
}
