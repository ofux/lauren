import { describe, expect, test } from 'vitest';

import { claudeAgent } from './claude.js';
import { codexAgent } from './codex.js';
import { DEFAULT_AGENTS, getAgent, resolveAgents } from './index.js';

describe('getAgent', () => {
  test('returns the claude singleton for "claude"', () => {
    expect(getAgent('claude')).toBe(claudeAgent);
  });

  test('returns the codex singleton for "codex"', () => {
    expect(getAgent('codex')).toBe(codexAgent);
  });
});

describe('resolveAgents', () => {
  test('resolves each role independently', () => {
    const resolved = resolveAgents({
      ...DEFAULT_AGENTS,
      implement: 'codex',
      review: 'claude',
    });
    expect(resolved.implement).toBe(codexAgent);
    expect(resolved.review).toBe(claudeAgent);
    expect(resolved.fix).toBe(claudeAgent);
    expect(resolved.merger).toBe(claudeAgent);
    expect(resolved.brain).toBe(claudeAgent);
  });

  test('preserves the legacy defaults', () => {
    const resolved = resolveAgents(DEFAULT_AGENTS);
    expect(resolved.implement).toBe(claudeAgent);
    expect(resolved.review).toBe(codexAgent);
    expect(resolved.fix).toBe(claudeAgent);
    expect(resolved.merger).toBe(claudeAgent);
    expect(resolved.brain).toBe(claudeAgent);
  });
});
