import path from 'node:path';
import { useInput } from 'ink';
import type React from 'react';
import { useEffect, useState } from 'react';
import { acknowledgeCheckpoint } from '../checkpoint.js';
import { REPO } from '../core/paths.js';
import { PlanStore } from '../core/store.js';
import { openInBrowser } from '../util/openInBrowser.js';
import type { WatcherRuntime } from './runtime.js';
import { WatcherProgress } from './WatcherProgress.js';

interface Props {
  runtime: WatcherRuntime;
  store: PlanStore;
}

// Single render budget for both sources of updates (animation timer + runtime
// notifications). 100ms matches the spinner cadence in `spinnerFrame()`; any
// faster just redraws identical frames and shows up as flicker on most
// terminals. Both the heartbeat and bursty notify()-driven updates are
// coalesced through `schedule()` so React never re-renders more than ~10×/sec.
const TICK_INTERVAL_MS = 100;

// Cadence for re-reading the plan store so newly enqueued plans surface in
// the queue panel even while the watcher loop is blocked in a long-running
// phase (e.g. implementing, sleeping between iterations). Matches
// `TodoApp.POLL_INTERVAL_MS` so both TUIs feel equally fresh.
const PLAN_POLL_INTERVAL_MS = 500;

export function App({ runtime, store }: Props): React.ReactElement {
  const [, setTick] = useState(0);

  useEffect(() => {
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastRenderAt = 0;

    const schedule = (): void => {
      if (pendingTimer !== null) return;
      const elapsed = performance.now() - lastRenderAt;
      const delay = elapsed >= TICK_INTERVAL_MS ? 0 : TICK_INTERVAL_MS - elapsed;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        lastRenderAt = performance.now();
        setTick((t) => (t + 1) | 0);
      }, delay);
    };

    const unsubscribe = runtime.subscribe(schedule);
    // Heartbeat so spinners and elapsed-time displays keep moving while idle
    // (no notify() calls to drive them).
    const heartbeat = setInterval(schedule, TICK_INTERVAL_MS);

    return () => {
      unsubscribe();
      clearInterval(heartbeat);
      if (pendingTimer !== null) clearTimeout(pendingTimer);
    };
  }, [runtime]);

  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const plans = await store.read();
        if (!cancelled) runtime.refreshPlans(plans);
      } catch {
        // Best-effort: the watcher loop is the authoritative reader and
        // will surface real store errors.
      }
    };
    const handle = setInterval(() => {
      void poll();
    }, PLAN_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [runtime, store]);

  useInput((input, key) => {
    // Ink keeps stdin in raw mode while `useInput` is mounted, which
    // suppresses OS-level SIGINT on Ctrl-C. Re-raise it ourselves so
    // the vibe daemon's SIGINT handler (graceful abort) still fires.
    if (key.ctrl && input === 'c') {
      process.kill(process.pid, 'SIGINT');
      return;
    }
    const awaiting = runtime.awaitingCheckpoint;
    if (!awaiting) return;
    if (input === 'o' || input === 'O') {
      const target = path.isAbsolute(awaiting.checkpoint.html_path)
        ? awaiting.checkpoint.html_path
        : path.resolve(REPO, awaiting.checkpoint.html_path);
      openInBrowser(target);
      return;
    }
    if (input === 'd' || input === 'D') {
      const slug = awaiting.plan.slug;
      void (async () => {
        try {
          const store = new PlanStore();
          await acknowledgeCheckpoint({ slug, store });
        } catch {
          // best-effort: the watcher loop will re-render the pause panel
          // if the ack didn't take.
        }
      })();
    }
  });

  return <WatcherProgress runtime={runtime} />;
}
