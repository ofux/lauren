import { Box, Text } from 'ink';
import React from 'react';

import { fmtDuration, monotonicSeconds } from '../core/time.js';
import { type PhaseName, STEP_PHASES } from '../executor.js';
import {
  getItemElapsed,
  getPhaseElapsed,
  getPhaseStatus,
  type ItemDisplayStatus,
  LOG_TAIL_LINES,
  type PhaseDisplayStatus,
  type PlanRuntimeState,
} from './runtime.js';
import { Spinner } from './Spinner.js';

interface Props {
  state: PlanRuntimeState;
}

function ItemLineInner({
  state,
  itemId,
  itemTitle,
  status,
}: {
  state: PlanRuntimeState;
  itemId: string;
  itemTitle: string;
  status: ItemDisplayStatus;
}): React.ReactElement {
  const now = monotonicSeconds();
  const elapsed = getItemElapsed(state, itemId, now);

  let icon: React.ReactNode;
  if (status === 'done')
    icon = (
      <Text color="green" bold>
        ✓{' '}
      </Text>
    );
  else if (status === 'running')
    icon = (
      <>
        <Spinner />
        <Text> </Text>
      </>
    );
  else if (status === 'failed')
    icon = (
      <Text color="red" bold>
        ✗{' '}
      </Text>
    );
  else icon = <Text dimColor>· </Text>;

  const titleProps: { bold?: boolean; dimColor?: boolean } = {};
  if (status === 'running') titleProps.bold = true;
  else if (status === 'pending') titleProps.dimColor = true;

  return (
    <Box>
      {icon}
      <Text {...titleProps}>{itemId}</Text>
      {itemTitle && itemTitle !== itemId && (
        <>
          <Text dimColor> — </Text>
          <Text {...titleProps}>{itemTitle}</Text>
        </>
      )}
      {(status === 'done' || status === 'running') && elapsed !== null && (
        <Text dimColor>{`  ${fmtDuration(elapsed)}`}</Text>
      )}
    </Box>
  );
}

function PhaseLineInner({
  state,
  itemId,
  phase,
  status,
}: {
  state: PlanRuntimeState;
  itemId: string;
  phase: PhaseName;
  status: PhaseDisplayStatus;
}): React.ReactElement {
  const now = monotonicSeconds();
  const elapsed = getPhaseElapsed(state, itemId, phase, now);

  if (status === 'done') {
    return (
      <Box paddingLeft={4}>
        <Text color="green" bold>
          ✓{' '}
        </Text>
        <Text>{phase}</Text>
        <Text dimColor>{`   ${fmtDuration(elapsed)}`}</Text>
      </Box>
    );
  }
  if (status === 'running') {
    return (
      <Box paddingLeft={4}>
        <Spinner />
        <Text> </Text>
        <Text color="cyan" bold>
          {phase}
        </Text>
        <Text dimColor>{`   ${fmtDuration(elapsed)}`}</Text>
      </Box>
    );
  }
  if (status === 'skipped') {
    return (
      <Box paddingLeft={4}>
        <Text dimColor>⊘ </Text>
        <Text dimColor>{phase}</Text>
        <Text dimColor italic>
          {' '}
          skipped
        </Text>
      </Box>
    );
  }
  if (status === 'failed') {
    return (
      <Box paddingLeft={4}>
        <Text color="red" bold>
          ✗{' '}
        </Text>
        <Text color="red">{phase}</Text>
      </Box>
    );
  }
  return (
    <Box paddingLeft={4}>
      <Text dimColor>· </Text>
      <Text dimColor>{phase}</Text>
    </Box>
  );
}

// The runtime mutates `state` in place and reuses the same object across
// renders, so default shallow memo would always skip. Compare the fields we
// actually read. `status` is passed as a primitive snapshot because re-reading
// it from `state` here would observe the already-mutated map on both sides of
// the comparison and hide transitions such as running → done. Running rows
// must re-render every tick so the spinner glyph and live elapsed timer keep
// advancing.
const ItemLine = React.memo(ItemLineInner, (prev, next) => {
  if (prev.itemId !== next.itemId || prev.itemTitle !== next.itemTitle) return false;
  if (next.status === 'running') return false;
  return prev.status === next.status;
});

const PhaseLine = React.memo(PhaseLineInner, (prev, next) => {
  if (prev.itemId !== next.itemId || prev.phase !== next.phase) return false;
  if (next.status === 'running') return false;
  return prev.status === next.status;
});

function _PanelHeader({
  title,
  borderColor,
}: {
  title: React.ReactNode;
  borderColor: string;
}): React.ReactElement {
  return (
    <Box>
      <Text color={borderColor}>┌─ </Text>
      {title}
      <Text color={borderColor}> ─</Text>
    </Box>
  );
}

export function PlanProgress({ state }: Props): React.ReactElement {
  const showLogPanel = state.currentPhase !== null;
  const tail = state.logTail.slice(-LOG_TAIL_LINES);
  while (tail.length < LOG_TAIL_LINES) tail.push('');

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text color="cyan" bold>{`running · ${state.planTitle}`}</Text>
        </Box>
        {state.items.map(({ id, title }) => {
          const itemStatus = state.itemStatus.get(id) ?? 'pending';
          const isRunning = itemStatus === 'running';
          return (
            <Box key={id} flexDirection="column">
              <ItemLine state={state} itemId={id} itemTitle={title} status={itemStatus} />
              {isRunning &&
                STEP_PHASES.map((phase) => {
                  const phaseStatus = getPhaseStatus(state, id, phase);
                  return (
                    <PhaseLine
                      key={`${id}:${phase}`}
                      state={state}
                      itemId={id}
                      phase={phase}
                      status={phaseStatus}
                    />
                  );
                })}
            </Box>
          );
        })}
      </Box>
      {showLogPanel && (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2}>
          <Box>
            <Spinner />
            <Text> </Text>
            <Text color="cyan">{state.logLabel}</Text>
          </Box>
          {tail.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ring-buffer slot is the identity here.
            <Text key={i} dimColor wrap="truncate-end">
              {line || ' '}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
