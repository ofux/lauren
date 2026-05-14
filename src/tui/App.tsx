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
}

const TICK_INTERVAL_MS = 80; // ~12 Hz, matches Python's Live(refresh_per_second=12)

export function App({ runtime }: Props): React.ReactElement {
  const [, setTick] = useState(0);

  useEffect(() => {
    const unsubscribe = runtime.subscribe(() => {
      setTick((t) => (t + 1) | 0);
    });
    return unsubscribe;
  }, [runtime]);

  // Animation tick — drives spinners and elapsed-time displays. Always
  // running (idle/running/paused) so spinners animate when idle too.
  useEffect(() => {
    const id = setInterval(() => {
      setTick((t) => (t + 1) | 0);
    }, TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

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
