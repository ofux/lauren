import { promises as fs } from 'node:fs';
import { Box, Text, useApp, useInput } from 'ink';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { type CancelOutcome, cancelPlan, isCancellable } from '../cancel.js';
import type { InboxStore } from '../core/inbox.js';
import type { TodoStore } from '../core/store.js';
import { fmtAge } from '../core/time.js';
import { type Plan, type PlanStatus, planFilePath } from '../core/types.js';
import { parsePlanFrontmatter } from '../util/planFrontmatter.js';
import { Spinner } from './Spinner.js';

const POLL_INTERVAL_MS = 500;

export interface TodoAppProps {
  todoStore: TodoStore;
  inboxStore: InboxStore;
}

interface Row {
  plan: Plan;
  store: 'inbox' | 'todo';
}

type View =
  | { kind: 'browse' }
  | { kind: 'confirm'; row: Row }
  | { kind: 'message'; outcome: CancelOutcome };

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
  rows,
  selectedIndex,
}: {
  rows: Row[];
  selectedIndex: number;
}): React.ReactElement {
  const widths = useMemo(() => {
    const slug = Math.max(4, ...rows.map((r) => r.plan.slug.length));
    const status = Math.max(12, ...rows.map((r) => r.plan.status.length));
    const title = Math.max(5, ...rows.map((r) => r.plan.title.length));
    return { slug, status, title };
  }, [rows]);

  return (
    <Box flexDirection="column">
      <Box>
        <Text
          bold
        >{`  ${pad('status', widths.status)}  ${pad('slug', widths.slug)}  ${pad('title', widths.title)}  age`}</Text>
      </Box>
      {rows.map((row, i) => {
        const selected = i === selectedIndex;
        const cancellable = isCancellable(row.plan);
        const color = statusColor(row.plan.status);
        const dim = statusIsDim(row.plan.status);
        const cursor = selected ? '▶ ' : '  ';
        const age = fmtAge(row.plan.created_at);
        const rowProps: { backgroundColor?: string } = selected ? { backgroundColor: 'gray' } : {};
        return (
          <Box key={`${row.store}:${row.plan.slug}`} {...rowProps}>
            <Text color={selected ? 'white' : undefined} bold={selected}>
              {cursor}
            </Text>
            <Text {...(color ? { color } : {})} dimColor={dim} bold={selected || cancellable}>
              {pad(row.plan.status, widths.status)}
            </Text>
            <Text> </Text>
            <Text bold dimColor={dim}>
              {pad(row.plan.slug, widths.slug)}
            </Text>
            <Text> </Text>
            <Text dimColor={dim}>{pad(row.plan.title, widths.title)}</Text>
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
  hasRows,
  selectedCancellable,
}: {
  hasRows: boolean;
  selectedCancellable: boolean;
}): React.ReactElement {
  return (
    <Box marginTop={1}>
      {hasRows ? (
        <Text dimColor>
          {selectedCancellable
            ? '↑/↓ navigate · Enter or c cancel · q quit'
            : '↑/↓ navigate · (selected row is not cancellable) · q quit'}
        </Text>
      ) : (
        <Text dimColor>q to quit</Text>
      )}
    </Box>
  );
}

async function loadRows(todoStore: TodoStore, inboxStore: InboxStore): Promise<Row[]> {
  const [inboxPlans, todoPlans] = await Promise.all([inboxStore.read(), todoStore.read()]);
  const rows: Row[] = [];
  for (const p of inboxPlans) rows.push({ plan: p, store: 'inbox' });
  for (const p of todoPlans) rows.push({ plan: p, store: 'todo' });
  return rows;
}

export function TodoApp({ todoStore, inboxStore }: TodoAppProps): React.ReactElement {
  const { exit } = useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [view, setView] = useState<View>({ kind: 'browse' });
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await loadRows(todoStore, inboxStore);
      setRows(next);
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
  }, [todoStore, inboxStore]);

  useEffect(() => {
    void refresh();
    const handle = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [refresh]);

  useInput((input, key) => {
    if (view.kind === 'confirm') {
      if (input === 'y' || input === 'Y') {
        const target = view.row;
        setView({ kind: 'browse' });
        void (async () => {
          try {
            const outcome = await cancelPlan({
              slug: target.plan.slug,
              store: target.store,
              todoStore,
              inboxStore,
            });
            setView({ kind: 'message', outcome });
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

    if (view.kind === 'message') {
      // Any key dismisses the message
      setView({ kind: 'browse' });
      return;
    }

    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    if (rows.length === 0) return;
    if (key.upArrow || input === 'k') {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setSelectedIndex((i) => Math.min(rows.length - 1, i + 1));
      return;
    }
    if (key.return || input === 'c') {
      const row = rows[selectedIndex];
      if (!row || !isCancellable(row.plan)) return;
      setView({ kind: 'confirm', row });
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

  const currentRow = rows[selectedIndex];
  const selectedCancellable = currentRow ? isCancellable(currentRow.plan) : false;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color="magenta" bold>
          ✨ lauren todo
        </Text>
        <Text dimColor>{`  (${rows.length} plan${rows.length === 1 ? '' : 's'})`}</Text>
      </Box>
      {error && (
        <Box marginBottom={1}>
          <Text color="red">error: {error}</Text>
        </Box>
      )}
      {rows.length === 0 ? (
        <Text dimColor italic>
          (empty queue)
        </Text>
      ) : (
        <PlanTable rows={rows} selectedIndex={selectedIndex} />
      )}
      {currentRow && <DescriptionPanel plan={currentRow.plan} />}
      <HelpFooter hasRows={rows.length > 0} selectedCancellable={selectedCancellable} />
      {view.kind === 'confirm' && (
        <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingX={2}>
          <Text>
            Cancel <Text bold>{view.row.plan.slug}</Text> (currently{' '}
            <Text bold>{view.row.plan.status}</Text>)? <Text dimColor>[y/N]</Text>
          </Text>
        </Box>
      )}
      {view.kind === 'message' && (
        <Box marginTop={1} borderStyle="round" borderColor="cyan" paddingX={2}>
          <Text>{view.outcome.message} </Text>
          <Text dimColor>(any key)</Text>
        </Box>
      )}
    </Box>
  );
}
