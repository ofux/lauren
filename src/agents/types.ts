import type { StreamSink } from '../proc/stream.js';

export type AgentName = 'claude' | 'codex';

export const AGENT_NAMES: readonly AgentName[] = ['claude', 'codex'] as const;

export function isAgentName(value: unknown): value is AgentName {
  return typeof value === 'string' && (AGENT_NAMES as readonly string[]).includes(value);
}

/**
 * Per-role agent assignment. The pipeline phases (implement, review, fix)
 * plus the two non-pipeline callers (merger, brain) each pick which CLI to
 * shell out to. Defaults preserve the original behavior: claude for code
 * edits and JSON decisions, codex for review.
 */
export interface AgentRoles {
  implement: AgentName;
  review: AgentName;
  fix: AgentName;
  merger: AgentName;
  brain: AgentName;
}

export const DEFAULT_AGENTS: AgentRoles = {
  implement: 'claude',
  review: 'codex',
  fix: 'claude',
  merger: 'claude',
  brain: 'claude',
};

/** Input for {@link CodingAgent.runEdit} — implement / fix / merger phases. */
export interface EditTaskInput {
  prompt: string;
  cwd: string;
  logPath: string;
  sink?: StreamSink;
  signal?: AbortSignal;
}

/**
 * Input for {@link CodingAgent.runReview}. The adapter must place the final
 * review text at `outputPath`; empty review is allowed (returned as text:'').
 */
export interface ReviewTaskInput {
  prompt: string;
  cwd: string;
  logPath: string;
  outputPath: string;
  sink?: StreamSink;
  signal?: AbortSignal;
}

/** Input for {@link CodingAgent.runJson} — brain placement / organize calls. */
export interface JsonTaskInput {
  systemPrompt: string;
  userPrompt: string;
  cwd?: string;
  signal?: AbortSignal;
}

export interface ReviewTaskResult {
  code: number;
  text: string;
}

/**
 * The port. Each method covers one shape of agent work:
 *  - runEdit  — modify the working tree (implement / fix / merger).
 *  - runReview — run a review pass that produces a text artifact at outputPath.
 *  - runJson  — one-shot JSON-returning decision (brain placement / organize).
 *
 * Adapters live in `src/agents/{claude,codex}.ts`. The factory in
 * `src/agents/index.ts` selects one by {@link AgentName}.
 */
export interface CodingAgent {
  readonly name: AgentName;
  runEdit(input: EditTaskInput): Promise<number>;
  runReview(input: ReviewTaskInput): Promise<ReviewTaskResult>;
  runJson(input: JsonTaskInput): Promise<unknown>;
}
