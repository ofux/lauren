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

import { type ParsedCheckpoint, SINGLE_UNIT_AFTER } from './checkpoints.js';

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
const CHECKPOINT_HEADING_RE = /^### Human Checkpoint — (.+?)\s*$/;
const MARKDOWN_LINK_RE = /\[[^\]]+\]\(([^)]+)\)/;

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

/**
 * Issues that make a checkpoint section unparseable. Returned alongside the
 * parsed list so `_register` can reject the plan with a precise message and
 * the parser stays pure (no thrown errors mid-traversal).
 */
export type CheckpointParseError =
  | { kind: 'no-link'; title: string }
  | { kind: 'multiple-checkpoints-in-single-unit'; titles: string[] }
  | { kind: 'non-trailing-checkpoint-in-single-unit'; title: string }
  | { kind: 'multiple-checkpoints-at-boundary'; after_step_id: string | null; titles: string[] };

export interface ParseCheckpointsResult {
  checkpoints: ParsedCheckpoint[];
  errors: CheckpointParseError[];
  /** True iff the markdown contains any `### Step X.Y` heading. */
  multiStep: boolean;
}

/**
 * Walk the plan markdown collecting both Step and Human Checkpoint headings
 * in source order. Each checkpoint records the id of the most recent Step
 * heading seen above it (or `null` for a leading checkpoint).
 *
 * The section body for a checkpoint must contain a markdown link `[label](path)`;
 * the first such link's target becomes the sidecar `html_path`. Sections
 * without a link are surfaced as a `no-link` error rather than silently
 * dropped.
 */
export function parseCheckpoints(text: string): ParseCheckpointsResult {
  type Section =
    | { kind: 'step'; id: string }
    | { kind: 'checkpoint'; title: string; bodyLines: string[]; followedByPeerHeading: boolean };

  const sections: Section[] = [];
  const seenStepIds = new Set<string>();
  const lines = text.split('\n');
  let current: Section | null = null;
  const closeCheckpointForHeading = () => {
    if (current?.kind === 'checkpoint') current.followedByPeerHeading = true;
    current = null;
  };
  for (const line of lines) {
    const stepMatch = STEP_HEADING_RE.exec(line);
    if (stepMatch) {
      closeCheckpointForHeading();
      const [, id] = stepMatch;
      if (id !== undefined && !seenStepIds.has(id)) {
        seenStepIds.add(id);
        sections.push({ kind: 'step', id });
      }
      continue;
    }
    const cpMatch = CHECKPOINT_HEADING_RE.exec(line);
    if (cpMatch) {
      closeCheckpointForHeading();
      const [, rawTitle] = cpMatch;
      if (rawTitle === undefined) continue;
      const section: Section = {
        kind: 'checkpoint',
        title: rawTitle.trim(),
        bodyLines: [],
        followedByPeerHeading: false,
      };
      sections.push(section);
      current = section;
      continue;
    }
    // Any other `###`-or-shallower heading closes the current checkpoint
    // section. Body lines accumulate into the last open checkpoint.
    if (/^#{1,3}\s/.test(line)) {
      closeCheckpointForHeading();
      continue;
    }
    if (current?.kind === 'checkpoint') current.bodyLines.push(line);
  }

  type ParsedCheckpointWithPosition = ParsedCheckpoint & { trailing: boolean };
  const checkpoints: ParsedCheckpointWithPosition[] = [];
  const errors: CheckpointParseError[] = [];
  let lastStepId: string | null = null;
  let cpIndex = 0;
  for (const section of sections) {
    if (section.kind === 'step') {
      lastStepId = section.id;
      continue;
    }
    cpIndex += 1;
    const linkMatch = section.bodyLines
      .map((l) => MARKDOWN_LINK_RE.exec(l))
      .find((m) => m !== null);
    if (!linkMatch) {
      errors.push({ kind: 'no-link', title: section.title });
      continue;
    }
    const linkTarget = linkMatch[1];
    if (linkTarget === undefined || linkTarget.trim() === '') {
      errors.push({ kind: 'no-link', title: section.title });
      continue;
    }
    checkpoints.push({
      id: `cp-${cpIndex}`,
      title: section.title,
      html_path: linkTarget.trim(),
      after_step_id: lastStepId,
      trailing: !section.followedByPeerHeading,
    });
  }

  const multiStep = seenStepIds.size > 0;
  if (!multiStep) {
    if (checkpoints.length > 1) {
      errors.push({
        kind: 'multiple-checkpoints-in-single-unit',
        titles: checkpoints.map((c) => c.title),
      });
    }
    for (const cp of checkpoints) {
      if (!cp.trailing) {
        errors.push({ kind: 'non-trailing-checkpoint-in-single-unit', title: cp.title });
      }
    }
    // In a single-unit plan there is only one implementation commit, so any
    // checkpoint is trailing. Rewrite `after_step_id` to the sentinel so the
    // executor can match against it after the single commit lands.
    for (const cp of checkpoints) cp.after_step_id = SINGLE_UNIT_AFTER;
  } else {
    const byBoundary = new Map<string, typeof checkpoints>();
    for (const cp of checkpoints) {
      const key = cp.after_step_id ?? '__leading__';
      const existing = byBoundary.get(key);
      if (existing === undefined) byBoundary.set(key, [cp]);
      else existing.push(cp);
    }
    for (const grouped of byBoundary.values()) {
      if (grouped.length <= 1) continue;
      errors.push({
        kind: 'multiple-checkpoints-at-boundary',
        after_step_id: grouped[0]?.after_step_id ?? null,
        titles: grouped.map((cp) => cp.title),
      });
    }
  }

  return {
    checkpoints: checkpoints.map(({ trailing: _trailing, ...cp }) => cp),
    errors,
    multiStep,
  };
}
