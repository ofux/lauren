import { Box, Text } from 'ink';
import type React from 'react';

import { fmtAge, fmtDuration, monotonicSeconds } from '../core/time.js';
import type { Plan, PlanStatus } from '../core/types.js';

import { PlanProgress } from './PlanProgress.js';
import type { WatcherRuntime } from './runtime.js';
import { Spinner } from './Spinner.js';

interface Props {
  runtime: WatcherRuntime;
}

function PlanRow({ plan }: { plan: Plan }): React.ReactElement {
  let icon: React.ReactNode;
  if (plan.status === 'done')
    icon = (
      <Text color="green" bold>
        ✓{' '}
      </Text>
    );
  else if (plan.status === 'implementing')
    icon = (
      <>
        <Spinner />
        <Text> </Text>
      </>
    );
  else if (plan.status === 'merging')
    icon = (
      <>
        <Spinner />
        <Text> </Text>
      </>
    );
  else if (plan.status === 'failed')
    icon = (
      <Text color="red" bold>
        ✗{' '}
      </Text>
    );
  else if (plan.status === 'cancelling')
    icon = (
      <Text color="red" bold>
        ⊘{' '}
      </Text>
    );
  else if (plan.status === 'merge_blocked')
    icon = (
      <Text color="yellow" bold>
        ⏸{' '}
      </Text>
    );
  else if (plan.status === 'awaiting_human')
    icon = (
      <Text color="magenta" bold>
        🚦{' '}
      </Text>
    );
  else if (plan.status === 'cancelled') icon = <Text dimColor>⊘ </Text>;
  else icon = <Text dimColor>· </Text>;

  const titleProps: { bold?: boolean; color?: string; dimColor?: boolean } = {};
  if (plan.status === 'implementing' || plan.status === 'merging') titleProps.bold = true;
  else if (plan.status === 'failed' || plan.status === 'cancelling') titleProps.color = 'red';
  else if (plan.status === 'merge_blocked') titleProps.color = 'yellow';
  else if (plan.status === 'awaiting_human') titleProps.color = 'magenta';
  else if (plan.status === 'done' || plan.status === 'cancelled') titleProps.dimColor = true;

  const age = fmtAge(plan.created_at);
  return (
    <Box>
      {icon}
      <Text {...titleProps}>{plan.slug}</Text>
      <Text dimColor> — </Text>
      <Text {...titleProps}>{plan.title}</Text>
      {age && <Text dimColor>{`  ${age}`}</Text>}
    </Box>
  );
}

function QueuePanel({ runtime }: Props): React.ReactElement {
  const { plans } = runtime;
  if (plans.length === 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="magenta"
        paddingX={2}
        paddingY={1}
      >
        <Box marginBottom={1}>
          <Text color="magenta" bold>
            ✨ vibe — queue
          </Text>
        </Box>
        <Text dimColor italic>
          (no plans queued)
        </Text>
      </Box>
    );
  }

  const counts: Record<PlanStatus, number> = {
    enqueued: 0,
    preparing: 0,
    ready: 0,
    implementing: 0,
    merging: 0,
    merge_blocked: 0,
    cancelling: 0,
    awaiting_human: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const p of plans) counts[p.status] += 1;
  const total = plans.length;
  const elapsed = monotonicSeconds() - runtime.startTime;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text color="magenta" bold>
          ✨ vibe — queue
        </Text>
      </Box>
      {plans.map((p) => (
        <PlanRow key={p.slug} plan={p} />
      ))}
      <Box marginTop={1}>
        <Text bold>{`${counts.done}/${total} done`}</Text>
        {counts.implementing > 0 && (
          <Text color="cyan">{`  ·  ${counts.implementing} running`}</Text>
        )}
        {counts.merging > 0 && <Text color="blue">{`  ·  ${counts.merging} merging`}</Text>}
        {counts.merge_blocked > 0 && (
          <Text color="yellow" bold>{`  ·  ${counts.merge_blocked} merge blocked`}</Text>
        )}
        {counts.ready > 0 && <Text>{`  ·  ${counts.ready} ready`}</Text>}
        {counts.failed > 0 && <Text color="red" bold>{`  ·  ${counts.failed} failed`}</Text>}
        {counts.awaiting_human > 0 && (
          <Text color="magenta" bold>{`  ·  ${counts.awaiting_human} awaiting human`}</Text>
        )}
        {counts.cancelled > 0 && <Text dimColor>{`  ·  ${counts.cancelled} cancelled`}</Text>}
        <Text dimColor>{`  ·  uptime ${fmtDuration(elapsed)}`}</Text>
      </Box>
    </Box>
  );
}

export function WatcherProgress({ runtime }: Props): React.ReactElement {
  return (
    <Box flexDirection="column">
      <QueuePanel runtime={runtime} />
      {runtime.idleState === 'running' && runtime.planProgress !== null ? (
        <PlanProgress state={runtime.planProgress} />
      ) : runtime.idleState === 'awaiting_human' && runtime.awaitingCheckpoint !== null ? (
        <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={2}>
          <Text color="magenta" bold>
            🚦 AWAITING HUMAN
          </Text>
          <Box>
            <Text>{runtime.awaitingCheckpoint.plan.slug}</Text>
            <Text dimColor> — </Text>
            <Text>{runtime.awaitingCheckpoint.plan.title}</Text>
          </Box>
          <Text bold>{runtime.awaitingCheckpoint.checkpoint.title}</Text>
          <Text
            dimColor
          >{`  instructions: ${runtime.awaitingCheckpoint.checkpoint.html_path}`}</Text>
          <Box marginTop={1}>
            <Text>
              Press <Text bold>o</Text> to open instructions, <Text bold>d</Text> when done.
            </Text>
          </Box>
        </Box>
      ) : runtime.idleState === 'paused' ? (
        <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={2}>
          <Text color="red" bold>
            ⏸ paused
          </Text>
          {runtime.idleMessage.split('\n').map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: idleMessage is fully replaced on each transition; row index is stable.
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      ) : runtime.idleState === 'organizing' && runtime.organizingPlan !== null ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={2}>
          <Box>
            <Spinner />
            <Text> </Text>
            <Text color="yellow" bold>
              organizing inbox
            </Text>
          </Box>
          <Box>
            <Text>{runtime.organizingPlan.slug}</Text>
            <Text dimColor> — </Text>
            <Text>{runtime.organizingPlan.title}</Text>
          </Box>
          {runtime.organizingNote !== null && (
            <Text dimColor italic>
              {runtime.organizingNote}
            </Text>
          )}
        </Box>
      ) : runtime.idleState === 'merging' && runtime.mergingPlan !== null ? (
        <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={2}>
          <Box>
            <Spinner />
            <Text> </Text>
            <Text color="blue" bold>
              {runtime.mergingMode === 'github-pr' ? 'merging (PR)' : 'merging'}
            </Text>
          </Box>
          <Box>
            <Text>{runtime.mergingPlan.slug}</Text>
            <Text dimColor> — </Text>
            <Text>{runtime.mergingPlan.title}</Text>
          </Box>
          {runtime.mergingMode === 'github-pr' &&
            runtime.mergingPlan.pr_urls &&
            Object.entries(runtime.mergingPlan.pr_urls).map(([repo, url]) => (
              <Box key={`${repo}:${url}`}>
                <Text dimColor>{repo === '.' ? 'PR:' : `${repo} PR:`}</Text>
                <Text> {url}</Text>
              </Box>
            ))}
          {runtime.mergingPlan.failure?.phase === 'cleanup' && (
            <Text color="yellow">{runtime.mergingPlan.failure.message}</Text>
          )}
        </Box>
      ) : (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={2}>
          <Box>
            <Spinner />
            <Text> </Text>
            <Text color="cyan">idle</Text>
          </Box>
          {runtime.idleMessage.split('\n').map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: idleMessage is fully replaced on each transition; row index is stable.
            <Text key={i} dimColor italic>
              {line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
