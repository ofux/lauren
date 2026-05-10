import { spawn } from 'node:child_process';

import { monotonicSeconds } from '../core/time.js';
import type { Plan } from '../core/types.js';
import {
  type ItemStatus,
  type PhaseName,
  type PhaseStatus,
  type ProgressSink,
  STEP_PHASES,
} from '../executor.js';
import { stripAnsi } from '../util/ansi.js';

export const LOG_TAIL_LINES = 8;

export type RuntimeIdleState = 'idle' | 'paused' | 'running' | 'organizing';
export type ItemDisplayStatus = 'pending' | 'running' | 'done' | 'failed';
export type PhaseDisplayStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface PlanItem {
  id: string;
  title: string;
}

export interface PlanRuntimeState {
  planTitle: string;
  startTime: number;
  items: PlanItem[];
  itemStatus: Map<string, ItemDisplayStatus>;
  itemStarted: Map<string, number>;
  itemFinished: Map<string, number>;
  phaseStatus: Map<string, PhaseDisplayStatus>; // key: `${itemId}:${phase}`
  phaseStarted: Map<string, number>;
  phaseFinished: Map<string, number>;
  currentItem: string | null;
  currentPhase: PhaseName | null;
  logLabel: string;
  logTail: string[]; // ring of last LOG_TAIL_LINES lines
}

function phaseKey(itemId: string, phase: PhaseName): string {
  return `${itemId}:${phase}`;
}

export function newPlanRuntimeState(args: {
  items: PlanItem[];
  planTitle: string;
}): PlanRuntimeState {
  const itemStatus = new Map<string, ItemDisplayStatus>();
  for (const it of args.items) itemStatus.set(it.id, 'pending');
  return {
    planTitle: args.planTitle,
    startTime: monotonicSeconds(),
    items: args.items,
    itemStatus,
    itemStarted: new Map(),
    itemFinished: new Map(),
    phaseStatus: new Map(),
    phaseStarted: new Map(),
    phaseFinished: new Map(),
    currentItem: null,
    currentPhase: null,
    logLabel: '',
    logTail: [],
  };
}

function failureMessageHasCommitRecovery(message: string, slug: string): boolean {
  return (
    message.toLowerCase().includes('commit manually') &&
    message.includes(`press \`t\` on '${slug}' in \`lauren\``)
  );
}

/**
 * Mutable runtime state for the vibe watcher. Acts as the {@link ProgressSink}
 * passed into the executor: every method mutates state then notifies
 * subscribers (the Ink App component) so the TUI rerenders.
 *
 * This is the bridge between the imperative async runner and React/Ink.
 */
export class WatcherRuntime implements ProgressSink {
  readonly startTime = monotonicSeconds();

  plans: Plan[] = [];
  currentPlan: Plan | null = null;
  organizingPlan: Plan | null = null;
  organizingNote: string | null = null;
  planProgress: PlanRuntimeState | null = null;
  idleState: RuntimeIdleState = 'idle';
  idleMessage = 'starting…';

  /** Slug of the failed plan we most recently transitioned-into-paused for.
   *  Used to dedup notification beeps when setPaused fires repeatedly while
   *  the watcher polls. Reset when we leave the paused state. */
  private pausedSlug: string | null = null;

  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Fire-and-forget notify. Listeners typically debounce via React state. */
  notify(): void {
    for (const fn of this.listeners) fn();
  }

  // Outer-state transitions ------------------------------------------------

  setRunning(plans: Plan[], plan: Plan, progress: PlanRuntimeState): void {
    this.plans = plans;
    this.currentPlan = plan;
    this.organizingPlan = null;
    this.organizingNote = null;
    this.planProgress = progress;
    this.idleState = 'running';
    this.pausedSlug = null;
    this.notify();
  }

  setIdle(plans: Plan[]): void {
    this.plans = plans;
    this.currentPlan = null;
    this.organizingPlan = null;
    this.organizingNote = null;
    this.planProgress = null;
    this.idleState = 'idle';
    this.pausedSlug = null;
    this.idleMessage =
      'waiting for plans…\n' + '  Run `lauren plan` (in another terminal) to add work.';
    this.notify();
  }

  setOrganizing(plans: Plan[], inboxPlan: Plan): void {
    this.plans = plans;
    this.currentPlan = null;
    this.organizingPlan = inboxPlan;
    this.organizingNote = null;
    this.planProgress = null;
    this.idleState = 'organizing';
    this.pausedSlug = null;
    this.notify();
  }

  setOrganizingNote(text: string): void {
    this.organizingNote = text;
    this.notify();
  }

  setPaused(plans: Plan[], failedPlan: Plan): void {
    const isNewPause = this.pausedSlug !== failedPlan.slug;
    this.plans = plans;
    this.currentPlan = null;
    this.organizingPlan = null;
    this.organizingNote = null;
    this.planProgress = null;
    this.idleState = 'paused';
    this.pausedSlug = failedPlan.slug;
    const f = failedPlan.failure;
    const phase = f ? f.phase : '?';
    const msg = f ? f.message : '(no message)';
    const ready = plans.filter((p) => p.status === 'ready').length;
    const indentedMsg = msg
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n');
    // Git commit failures already explain the manual-fix path including the
    // retry command. Other commit-phase failures still need the generic hint.
    const hasRecoveryHint =
      phase === 'commit' && failureMessageHasCommitRecovery(msg, failedPlan.slug);
    const trailer = hasRecoveryHint
      ? `  ${ready} plan(s) queued behind it.`
      : `  ${ready} plan(s) queued behind it.\n` +
        `  Press \`t\` on '${failedPlan.slug}' in \`lauren\` to reset it to ready, ` +
        `or cancel it from there.`;
    this.idleMessage = `PAUSED: plan '${failedPlan.slug}' failed at ${phase}.\n${indentedMsg}\n${trailer}`;
    if (isNewPause) playPauseNotification();
    this.notify();
  }

  setPausedCancelling(plans: Plan[], plan: Plan): void {
    const isNewPause = this.pausedSlug !== plan.slug;
    this.plans = plans;
    this.currentPlan = null;
    this.organizingPlan = null;
    this.organizingNote = null;
    this.planProgress = null;
    this.idleState = 'paused';
    this.pausedSlug = plan.slug;
    const ready = plans.filter((p) => p.status === 'ready').length;
    this.idleMessage =
      `PAUSED: plan '${plan.slug}' is cancelling — uncommitted changes left on disk.\n` +
      `  Inspect with \`git status\`, then commit/stash/discard, and set\n` +
      `  status to 'cancelled' in .lauren/plans.json to resume.\n` +
      `  ${ready} plan(s) queued behind it.`;
    if (isNewPause) playPauseNotification();
    this.notify();
  }

  setPausedDirtyWorkspace(plans: Plan[], dirtyRepos: string): void {
    const isNewPause = this.pausedSlug !== '__dirty_workspace__';
    this.plans = plans;
    this.currentPlan = null;
    this.organizingPlan = null;
    this.organizingNote = null;
    this.planProgress = null;
    this.idleState = 'paused';
    this.pausedSlug = '__dirty_workspace__';
    const ready = plans.filter((p) => p.status === 'ready').length;
    this.idleMessage =
      `PAUSED: working tree is dirty after cancellation cleared.\n` +
      `  Dirty repo(s): ${dirtyRepos}.\n` +
      `  Commit/stash/discard changes before vibe resumes.\n` +
      `  ${ready} plan(s) queued behind it.`;
    if (isNewPause) playPauseNotification();
    this.notify();
  }

  refreshPlans(plans: Plan[]): void {
    this.plans = plans;
    this.notify();
  }

  // ProgressSink implementation -------------------------------------------

  appendLog(line: string): void {
    const s = stripAnsi(line).replace(/\s+$/, '');
    if (!s) return;
    if (!this.planProgress) return;
    this.planProgress.logTail.push(s);
    while (this.planProgress.logTail.length > LOG_TAIL_LINES) {
      this.planProgress.logTail.shift();
    }
    this.notify();
  }

  markItemDone(itemId: string): void {
    if (!this.planProgress) return;
    this.planProgress.itemStatus.set(itemId, 'done');
    this.notify();
  }

  beginItem(itemId: string): void {
    if (!this.planProgress) return;
    this.planProgress.currentItem = itemId;
    this.planProgress.itemStatus.set(itemId, 'running');
    this.planProgress.itemStarted.set(itemId, monotonicSeconds());
    for (const phase of STEP_PHASES) {
      this.planProgress.phaseStatus.set(phaseKey(itemId, phase), 'pending');
    }
    this.notify();
  }

  endItem(itemId: string, status: ItemStatus): void {
    if (!this.planProgress) return;
    this.planProgress.itemStatus.set(itemId, status);
    this.planProgress.itemFinished.set(itemId, monotonicSeconds());
    if (this.planProgress.currentItem === itemId) {
      this.planProgress.currentItem = null;
    }
    this.planProgress.currentPhase = null;
    this.notify();
  }

  beginPhase(itemId: string, phase: PhaseName, label: string): void {
    if (!this.planProgress) return;
    this.planProgress.currentPhase = phase;
    this.planProgress.phaseStatus.set(phaseKey(itemId, phase), 'running');
    this.planProgress.phaseStarted.set(phaseKey(itemId, phase), monotonicSeconds());
    this.planProgress.logTail.length = 0;
    this.planProgress.logLabel = label || `${phase} · ${itemId}`;
    this.notify();
  }

  endPhase(itemId: string, phase: PhaseName, status: PhaseStatus): void {
    if (!this.planProgress) return;
    this.planProgress.phaseStatus.set(phaseKey(itemId, phase), status);
    this.planProgress.phaseFinished.set(phaseKey(itemId, phase), monotonicSeconds());
    if (this.planProgress.currentPhase === phase) {
      this.planProgress.currentPhase = null;
    }
    this.notify();
  }
}

export function getPhaseStatus(
  state: PlanRuntimeState,
  itemId: string,
  phase: PhaseName,
): PhaseDisplayStatus {
  return state.phaseStatus.get(phaseKey(itemId, phase)) ?? 'pending';
}

export function getPhaseElapsed(
  state: PlanRuntimeState,
  itemId: string,
  phase: PhaseName,
  now: number,
): number {
  const status = getPhaseStatus(state, itemId, phase);
  const startedAt = state.phaseStarted.get(phaseKey(itemId, phase));
  if (startedAt === undefined) return 0;
  if (status === 'running') return now - startedAt;
  const finishedAt = state.phaseFinished.get(phaseKey(itemId, phase));
  if (finishedAt === undefined) return 0;
  return finishedAt - startedAt;
}

export function getItemElapsed(
  state: PlanRuntimeState,
  itemId: string,
  now: number,
): number | null {
  const startedAt = state.itemStarted.get(itemId);
  if (startedAt === undefined) return null;
  const status = state.itemStatus.get(itemId);
  if (status === 'running') return now - startedAt;
  const finishedAt = state.itemFinished.get(itemId);
  if (finishedAt === undefined) return null;
  return finishedAt - startedAt;
}

/**
 * Best-effort notification when vibe transitions into the paused state.
 * Always emits the terminal BEL (works in any TTY); on macOS additionally
 * spawns `afplay` for an audible cue. Every step is wrapped in try/catch
 * because failure to play a sound must never crash the watcher.
 *
 * Set LAUREN_NO_SOUND=1 to silence both.
 */
export function playPauseNotification(): void {
  if (process.env.LAUREN_NO_SOUND === '1') return;
  try {
    process.stdout.write('\x07');
  } catch {
    // Writing BEL can fail if stdout was closed — ignore.
  }
  if (process.platform === 'darwin') {
    try {
      const child = spawn('afplay', ['/System/Library/Sounds/Glass.aiff'], {
        stdio: 'ignore',
        detached: true,
      });
      child.on('error', () => {
        // afplay missing or failed; the BEL already fired.
      });
      child.unref();
    } catch {
      // spawn itself can throw (e.g. EMFILE) — ignore.
    }
  }
}
