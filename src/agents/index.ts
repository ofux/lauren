import { claudeAgent } from './claude.js';
import { codexAgent } from './codex.js';
import type { AgentName, AgentRoles, CodingAgent } from './types.js';

export type {
  AgentName,
  AgentRoles,
  CodingAgent,
  EditTaskInput,
  JsonTaskInput,
  ReviewTaskInput,
  ReviewTaskResult,
} from './types.js';
export { AGENT_NAMES, DEFAULT_AGENTS, isAgentName } from './types.js';

/** Resolve an {@link AgentName} to its singleton adapter instance. */
export function getAgent(name: AgentName): CodingAgent {
  switch (name) {
    case 'claude':
      return claudeAgent;
    case 'codex':
      return codexAgent;
  }
}

export interface ResolvedAgents {
  implement: CodingAgent;
  review: CodingAgent;
  fix: CodingAgent;
  merger: CodingAgent;
  brain: CodingAgent;
}

/** Resolve every {@link AgentRoles} entry to its {@link CodingAgent}. */
export function resolveAgents(roles: AgentRoles): ResolvedAgents {
  return {
    implement: getAgent(roles.implement),
    review: getAgent(roles.review),
    fix: getAgent(roles.fix),
    merger: getAgent(roles.merger),
    brain: getAgent(roles.brain),
  };
}
