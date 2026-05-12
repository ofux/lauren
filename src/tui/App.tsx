import type React from 'react';
import { useEffect, useState } from 'react';
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

  return <WatcherProgress runtime={runtime} />;
}
