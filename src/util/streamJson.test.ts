import { describe, expect, test } from 'vitest';
import { formatClaudeStreamLine, parseClaudeOneshotResult } from './streamJson.js';

describe('formatClaudeStreamLine', () => {
  test('returns [] for empty/whitespace input', () => {
    expect(formatClaudeStreamLine('')).toEqual([]);
    expect(formatClaudeStreamLine('   \t  ')).toEqual([]);
  });

  test('passes non-JSON lines through unchanged (trimmed)', () => {
    expect(formatClaudeStreamLine('  hello world  ')).toEqual(['hello world']);
  });

  test('formats system init events with model name', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', model: 'opus-4' });
    expect(formatClaudeStreamLine(line)).toEqual(['session started · opus-4']);
  });

  test('formats system init events without a model (strips trailing separator)', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init' });
    expect(formatClaudeStreamLine(line)).toEqual(['session started']);
  });

  test('extracts the first line of assistant text content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '  first line\nsecond line  ' }] },
    });
    expect(formatClaudeStreamLine(line)).toEqual(['first line']);
  });

  test('formats tool_use blocks with file_path preview', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/abs/foo.ts' } }],
      },
    });
    expect(formatClaudeStreamLine(line)).toEqual(['→ Read(/abs/foo.ts)']);
  });

  test('formats tool_use blocks with command preview (Bash) — first line only', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la\necho ignored' } }],
      },
    });
    expect(formatClaudeStreamLine(line)).toEqual(['→ Bash(ls -la)']);
  });

  test('formats tool_use blocks without preview keys as just the name', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Tool', input: {} }] },
    });
    expect(formatClaudeStreamLine(line)).toEqual(['→ Tool']);
  });

  test('formats result events with cost', () => {
    const line = JSON.stringify({ type: 'result', total_cost_usd: 0.12345 });
    expect(formatClaudeStreamLine(line)).toEqual(['✓ done · $0.1235']);
  });

  test('formats result error events with truncated message', () => {
    const longMsg = 'x'.repeat(200);
    const [out] = formatClaudeStreamLine(
      JSON.stringify({ type: 'result', is_error: true, result: longMsg }),
    );
    expect(out).toMatch(/^✗ error: x{120}$/);
  });

  test('returns [] for unknown event types', () => {
    expect(formatClaudeStreamLine(JSON.stringify({ type: 'mystery' }))).toEqual([]);
  });
});

describe('parseClaudeOneshotResult', () => {
  test('returns the final result string from a result event', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'result', result: 'final output' }),
    ].join('\n');
    expect(parseClaudeOneshotResult(stdout)).toBe('final output');
  });

  test('returns "" when no result event is present', () => {
    const stdout = JSON.stringify({ type: 'system', subtype: 'init' });
    expect(parseClaudeOneshotResult(stdout)).toBe('');
  });

  test('throws when the result is an error', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: true, result: 'boom' });
    expect(() => parseClaudeOneshotResult(stdout)).toThrow(/claude returned error: boom/);
  });

  test('skips malformed lines without throwing', () => {
    const stdout = ['not json', JSON.stringify({ type: 'result', result: 'ok' })].join('\n');
    expect(parseClaudeOneshotResult(stdout)).toBe('ok');
  });
});
