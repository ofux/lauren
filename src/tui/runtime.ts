import { spawn } from 'node:child_process';

import { monotonicSeconds } from '../core/time.js';
import type { Plan } from '../core/types.js';
import {
  type ItemStatus,
  PR_STEPS,
  type ProgressSink,
  type StepName,
  type StepStatus,
} from '../executor.js';
import { stripAnsi } from '../util/ansi.js';

export const LOG_TAIL_LINES = 8;

export type RuntimeIdleState = 'idle' | 'paused' | 'running' | 'organizing';
export type ItemDisplayStatus = 'pending' | 'running' | 'done' | 'failed';
export type StepDisplayStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

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
  stepStatus: Map<string, StepDisplayStatus>; // key: `${itemId}:${step}`
  stepStarted: Map<string, number>;
  stepFinished: Map<string, number>;
  currentItem: string | null;
  currentStep: StepName | null;
  logLabel: string;
  logTail: string[]; // ring of last LOG_TAIL_LINES lines
}

function stepKey(itemId: string, step: StepName): string {
  return `${itemId}:${step}`;
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
    stepStatus: new Map(),
    stepStarted: new Map(),
    stepFinished: new Map(),
    currentItem: null,
    currentStep: null,
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
    const step = f ? f.step : '?';
    const msg = f ? f.message : '(no message)';
    const ready = plans.filter((p) => p.status === 'ready').length;
    const indentedMsg = msg
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n');
    // Git commit failures already explain the manual-fix path including the
    // retry command. Other commit-step failures still need the generic hint.
    const hasRecoveryHint =
      step === 'commit' && failureMessageHasCommitRecovery(msg, failedPlan.slug);
    const trailer = hasRecoveryHint
      ? `  ${ready} plan(s) queued behind it.`
      : `  ${ready} plan(s) queued behind it.\n` +
        `  Press \`t\` on '${failedPlan.slug}' in \`lauren\` to reset it to ready, ` +
        `or cancel it from there.`;
    this.idleMessage = `PAUSED: plan '${failedPlan.slug}' failed at ${step}.\n${indentedMsg}\n${trailer}`;
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
    for (const step of PR_STEPS) {
      this.planProgress.stepStatus.set(stepKey(itemId, step), 'pending');
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
    this.planProgress.currentStep = null;
    this.notify();
  }

  beginStep(itemId: string, step: StepName, label: string): void {
    if (!this.planProgress) return;
    this.planProgress.currentStep = step;
    this.planProgress.stepStatus.set(stepKey(itemId, step), 'running');
    this.planProgress.stepStarted.set(stepKey(itemId, step), monotonicSeconds());
    this.planProgress.logTail.length = 0;
    this.planProgress.logLabel = label || `${step} · ${itemId}`;
    this.notify();
  }

  endStep(itemId: string, step: StepName, status: StepStatus): void {
    if (!this.planProgress) return;
    this.planProgress.stepStatus.set(stepKey(itemId, step), status);
    this.planProgress.stepFinished.set(stepKey(itemId, step), monotonicSeconds());
    if (this.planProgress.currentStep === step) {
      this.planProgress.currentStep = null;
    }
    this.notify();
  }
}

export function getStepStatus(
  state: PlanRuntimeState,
  itemId: string,
  step: StepName,
): StepDisplayStatus {
  return state.stepStatus.get(stepKey(itemId, step)) ?? 'pending';
}

export function getStepElapsed(
  state: PlanRuntimeState,
  itemId: string,
  step: StepName,
  now: number,
): number {
  const status = getStepStatus(state, itemId, step);
  const startedAt = state.stepStarted.get(stepKey(itemId, step));
  if (startedAt === undefined) return 0;
  if (status === 'running') return now - startedAt;
  const finishedAt = state.stepFinished.get(stepKey(itemId, step));
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
