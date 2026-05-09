import { promises as fs } from 'node:fs';
import { Box, Text, useApp, useInput } from 'ink';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { applyOrganizeDecision, brainOrganizeQueue, summarizeOrganizeDecision } from '../brain.js';
import { cancelPlan, isCancellable } from '../cancel.js';
import { VIBE_PID_PATH } from '../core/paths.js';
import type { PlanStore } from '../core/store.js';
import { fmtAge } from '../core/time.js';
import { type Plan, type PlanStatus, planFilePath } from '../core/types.js';
import { readLivePid } from '../proc/pid.js';
import { isRetryable, retryPlan } from '../retry.js';
import { parsePlanFrontmatter } from '../util/planFrontmatter.js';
import { Spinner } from './Spinner.js';

const POLL_INTERVAL_MS = 500;

export interface TodoAppProps {
  store: PlanStore;
}

type View =
  | { kind: 'browse' }
  | { kind: 'confirm-cancel'; plan: Plan }
  | { kind: 'confirm-retry'; plan: Plan }
  | { kind: 'reorganize-loading' }
  | {
      kind: 'reorganize-confirm';
      decision: unknown;
      summary: string[];
      reasoning: string;
    }
  | { kind: 'message'; message: string };

function statusColor(status: PlanStatus): string | undefined {
  switch (status) {
    case 'failed':
      return 'red';
    case 'implementing':
      return 'cyan';
    case 'preparing':
      return 'magenta';
    case 'enqueued':
      return 'yellow';
    case 'ready':
      return 'green';
    default:
      return undefined;
  }
}

function statusIsDim(status: PlanStatus): boolean {
  return status === 'done' || status === 'cancelled';
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function PlanTable({
  plans,
  selectedIndex,
}: {
  plans: Plan[];
  selectedIndex: number;
}): React.ReactElement {
  const widths = useMemo(() => {
    const slug = Math.max(4, ...plans.map((p) => p.slug.length));
    const status = Math.max(12, ...plans.map((p) => p.status.length));
    const title = Math.max(5, ...plans.map((p) => p.title.length));
    return { slug, status, title };
  }, [plans]);

  return (
    <Box flexDirection="column">
      <Box>
        <Text
          bold
        >{`  ${pad('status', widths.status)}  ${pad('slug', widths.slug)}  ${pad('title', widths.title)}  age`}</Text>
      </Box>
      {plans.map((plan, i) => {
        const selected = i === selectedIndex;
        const cancellable = isCancellable(plan);
        const color = statusColor(plan.status);
        const dim = statusIsDim(plan.status);
        const cursor = selected ? '▶ ' : '  ';
        const age = fmtAge(plan.created_at);
        const rowProps: { backgroundColor?: string } = selected ? { backgroundColor: 'gray' } : {};
        return (
          <Box key={plan.slug} {...rowProps}>
            <Text color={selected ? 'white' : undefined} bold={selected}>
              {cursor}
            </Text>
            <Text {...(color ? { color } : {})} dimColor={dim} bold={selected || cancellable}>
              {pad(plan.status, widths.status)}
            </Text>
            <Text> </Text>
            <Text bold dimColor={dim}>
              {pad(plan.slug, widths.slug)}
            </Text>
            <Text> </Text>
            <Text dimColor={dim}>{pad(plan.title, widths.title)}</Text>
            <Text dimColor>{`  ${age}`}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

type DescriptionState =
  | { kind: 'loading' }
  | { kind: 'ok'; text: string }
  | { kind: 'fallback'; text: string };

function DescriptionPanel({ plan }: { plan: Plan }): React.ReactElement {
  const [state, setState] = useState<DescriptionState>({ kind: 'loading' });
  const filePath = planFilePath(plan);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void (async () => {
      let raw: string;
      try {
        raw = await fs.readFile(filePath, 'utf8');
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          setState({ kind: 'fallback', text: '(plan file missing)' });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          setState({ kind: 'fallback', text: `(failed to read plan: ${msg})` });
        }
        return;
      }
      if (cancelled) return;
      const { frontmatter } = parsePlanFrontmatter(raw);
      if (frontmatter && frontmatter.description.trim() !== '') {
        setState({ kind: 'ok', text: frontmatter.description });
      } else {
        setState({ kind: 'fallback', text: '(no summary in plan)' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return (
    <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={2} flexDirection="column">
      <Text bold dimColor>
        summary — {plan.slug}
      </Text>
      {state.kind === 'loading' ? (
        <Text dimColor italic>
          loading…
        </Text>
      ) : state.kind === 'ok' ? (
        state.text.split('\n').map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are stable for this render
          <Text key={i}>{line}</Text>
        ))
      ) : (
        <Text dimColor italic>
          {state.text}
        </Text>
      )}
    </Box>
  );
}

function HelpFooter({
  hasPlans,
  selectedCancellable,
  selectedRetryable,
  canReorganize,
}: {
  hasPlans: boolean;
  selectedCancellable: boolean;
  selectedRetryable: boolean;
  canReorganize: boolean;
}): React.ReactElement {
  if (!hasPlans) {
    return (
      <Box marginTop={1}>
        <Text dimColor>q to quit</Text>
      </Box>
    );
  }
  const hints: string[] = ['↑/↓ navigate'];
  if (selectedCancellable) hints.push('Enter or c cancel');
  if (selectedRetryable) hints.push('t reset to ready');
  if (canReorganize) hints.push('r reorganize');
  hints.push('q quit');
  return (
    <Box marginTop={1}>
      <Text dimColor>{hints.join(' · ')}</Text>
    </Box>
  );
}

export function TodoApp({ store }: TodoAppProps): React.ReactElement {
  const { exit } = useApp();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [view, setView] = useState<View>({ kind: 'browse' });
  const [vibeRunning, setVibeRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [next, pid] = await Promise.all([store.read(), readLivePid(VIBE_PID_PATH)]);
      setPlans(next);
      setVibeRunning(pid !== null);
      setLoaded(true);
      setError(null);
      setSelectedIndex((prev) => {
        if (next.length === 0) return 0;
        if (prev >= next.length) return next.length - 1;
        return prev;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
  }, [store]);

  useEffect(() => {
    void refresh();
    const handle = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [refresh]);

  const readyCount = useMemo(() => plans.filter((p) => p.status === 'ready').length, [plans]);
  const canReorganize = !vibeRunning && readyCount >= 2;

  useInput((input, key) => {
    if (view.kind === 'confirm-cancel') {
      if (input === 'y' || input === 'Y') {
        const target = view.plan;
        setView({ kind: 'browse' });
        void (async () => {
          try {
            const outcome = await cancelPlan({ slug: target.slug, store });
            setView({ kind: 'message', message: outcome.message });
            await refresh();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setError(msg);
          }
        })();
        return;
      }
      if (input === 'n' || input === 'N' || key.escape) {
        setView({ kind: 'browse' });
        return;
      }
      return;
    }

    if (view.kind === 'confirm-retry') {
      if (input === 'y' || input === 'Y') {
        const target = view.plan;
        setView({ kind: 'browse' });
        void (async () => {
          try {
            const outcome = await retryPlan({ slug: target.slug, store });
            setView({ kind: 'message', message: outcome.message });
            await refresh();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setError(msg);
          }
        })();
        return;
      }
      if (input === 'n' || input === 'N' || key.escape) {
        setView({ kind: 'browse' });
        return;
      }
      return;
    }

    if (view.kind === 'reorganize-loading') {
      // Block input until the brain returns.
      return;
    }

    if (view.kind === 'reorganize-confirm') {
      if (input === 'y' || input === 'Y') {
        const decision = view.decision;
        setView({ kind: 'reorganize-loading' });
        void (async () => {
          try {
            const lines = await applyOrganizeDecision(store, decision);
            const message =
              lines.length > 0
                ? `reorganize applied:\n${lines.join('\n')}`
                : 'reorganize applied (no operations).';
            setView({ kind: 'message', message });
            await refresh();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setView({ kind: 'message', message: `reorganize failed: ${msg}` });
          }
        })();
        return;
      }
      if (input === 'n' || input === 'N' || key.escape) {
        setView({ kind: 'browse' });
        return;
      }
      return;
    }

    if (view.kind === 'message') {
      // Any key dismisses the message
      setView({ kind: 'browse' });
      return;
    }

    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    if (plans.length === 0) return;
    if (key.upArrow || input === 'k') {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setSelectedIndex((i) => Math.min(plans.length - 1, i + 1));
      return;
    }
    if (key.return || input === 'c') {
      const plan = plans[selectedIndex];
      if (!plan || !isCancellable(plan)) return;
      setView({ kind: 'confirm-cancel', plan });
      return;
    }
    if (input === 't') {
      const plan = plans[selectedIndex];
      if (!plan || !isRetryable(plan)) return;
      setView({ kind: 'confirm-retry', plan });
      return;
    }
    if (input === 'r') {
      if (!canReorganize) return;
      setView({ kind: 'reorganize-loading' });
      void (async () => {
        try {
          const { decision } = await brainOrganizeQueue(store);
          const summary = summarizeOrganizeDecision(decision);
          const reasoning = decision.reasoning.trim();
          setView({ kind: 'reorganize-confirm', decision, summary, reasoning });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setView({ kind: 'message', message: `reorganize failed: ${msg}` });
        }
      })();
      return;
    }
  });

  if (!loaded) {
    return (
      <Box>
        <Spinner />
        <Text> loading queue…</Text>
      </Box>
    );
  }

  const current = plans[selectedIndex];
  const selectedCancellable = current ? isCancellable(current) : false;
  const selectedRetryable = current ? isRetryable(current) : false;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color="magenta" bold>
          ✨ lauren
        </Text>
        <Text dimColor>{`  (${plans.length} plan${plans.length === 1 ? '' : 's'})`}</Text>
      </Box>
      {error && (
        <Box marginBottom={1}>
          <Text color="red">error: {error}</Text>
        </Box>
      )}
      {plans.length === 0 ? (
        <Text dimColor italic>
          (empty queue)
        </Text>
      ) : (
        <PlanTable plans={plans} selectedIndex={selectedIndex} />
      )}
      {current && <DescriptionPanel plan={current} />}
      <HelpFooter
        hasPlans={plans.length > 0}
        selectedCancellable={selectedCancellable}
        selectedRetryable={selectedRetryable}
        canReorganize={canReorganize}
      />
      {view.kind === 'confirm-cancel' && (
        <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingX={2}>
          <Text>
            Cancel <Text bold>{view.plan.slug}</Text> (currently{' '}
            <Text bold>{view.plan.status}</Text>)? <Text dimColor>[y/N]</Text>
          </Text>
        </Box>
      )}
      {view.kind === 'confirm-retry' && (
        <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingX={2}>
          <Text>
            Reset <Text bold>{view.plan.slug}</Text> back to <Text bold>ready</Text>?{' '}
            <Text dimColor>[y/N]</Text>
          </Text>
        </Box>
      )}
      {view.kind === 'reorganize-loading' && (
        <Box marginTop={1} borderStyle="round" borderColor="magenta" paddingX={2}>
          <Spinner />
          <Text> brain is thinking…</Text>
        </Box>
      )}
      {view.kind === 'reorganize-confirm' && (
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor="magenta"
          paddingX={2}
          flexDirection="column"
        >
          <Text bold>brain proposes:</Text>
          {view.summary.length === 0 ? (
            <Text dimColor italic>
              (no operations)
            </Text>
          ) : (
            view.summary.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are stable for this render
              <Text key={i}> {line}</Text>
            ))
          )}
          {view.reasoning !== '' && (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>reasoning:</Text>
              <Text dimColor>{view.reasoning}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text>
              Apply? <Text dimColor>[y/N]</Text>
            </Text>
          </Box>
        </Box>
      )}
      {view.kind === 'message' && (
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor="cyan"
          paddingX={2}
          flexDirection="column"
        >
          {view.message.split('\n').map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines are stable for this render
            <Text key={i}>{line}</Text>
          ))}
          <Text dimColor>(any key to dismiss)</Text>
        </Box>
      )}
    </Box>
  );
}
