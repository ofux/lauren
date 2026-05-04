import { Box, Text } from 'ink';
import type React from 'react';

import { fmtDuration, monotonicSeconds } from '../core/time.js';
import { PR_STEPS, type StepName } from '../executor.js';
import {
  getItemElapsed,
  getStepElapsed,
  getStepStatus,
  type ItemDisplayStatus,
  LOG_TAIL_LINES,
  type PlanRuntimeState,
  type StepDisplayStatus,
} from './runtime.js';
import { Spinner } from './Spinner.js';

interface Props {
  state: PlanRuntimeState;
}

function ItemLine({
  state,
  itemId,
  itemTitle,
}: {
  state: PlanRuntimeState;
  itemId: string;
  itemTitle: string;
}): React.ReactElement {
  const status: ItemDisplayStatus = state.itemStatus.get(itemId) ?? 'pending';
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

function StepLine({
  state,
  itemId,
  step,
}: {
  state: PlanRuntimeState;
  itemId: string;
  step: StepName;
}): React.ReactElement {
  const status: StepDisplayStatus = getStepStatus(state, itemId, step);
  const now = monotonicSeconds();
  const elapsed = getStepElapsed(state, itemId, step, now);

  if (status === 'done') {
    return (
      <Box paddingLeft={4}>
        <Text color="green" bold>
          ✓{' '}
        </Text>
        <Text>{step}</Text>
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
          {step}
        </Text>
        <Text dimColor>{`   ${fmtDuration(elapsed)}`}</Text>
      </Box>
    );
  }
  if (status === 'skipped') {
    return (
      <Box paddingLeft={4}>
        <Text dimColor>⊘ </Text>
        <Text dimColor>{step}</Text>
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
        <Text color="red">{step}</Text>
      </Box>
    );
  }
  return (
    <Box paddingLeft={4}>
      <Text dimColor>· </Text>
      <Text dimColor>{step}</Text>
    </Box>
  );
}

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
  const showLogPanel = state.currentStep !== null;
  const tail = state.logTail.slice(-LOG_TAIL_LINES);
  while (tail.length < LOG_TAIL_LINES) tail.push('');

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text color="cyan" bold>{`running · ${state.planTitle}`}</Text>
        </Box>
        {state.items.map(({ id, title }) => {
          const isRunning = state.itemStatus.get(id) === 'running';
          return (
            <Box key={id} flexDirection="column">
              <ItemLine state={state} itemId={id} itemTitle={title} />
              {isRunning &&
                PR_STEPS.map((step) => (
                  <StepLine key={`${id}:${step}`} state={state} itemId={id} step={step} />
                ))}
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
