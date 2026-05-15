import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';

import { REPO } from '../core/paths.js';
import { runCodexReview } from '../proc/codex.js';
import { streamSubprocess } from '../proc/stream.js';
import { codexAgent, extractLastJsonObject } from './codex.js';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

vi.mock('../proc/stream.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../proc/stream.js')>();
  return { ...actual, streamSubprocess: vi.fn() };
});

vi.mock('../proc/codex.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../proc/codex.js')>();
  return { ...actual, runCodexReview: vi.fn() };
});

function mockCodexJsonSpawn(stdout: string): void {
  spawnMock.mockImplementationOnce(() => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true) as ChildProcessWithoutNullStreams['kill'];

    queueMicrotask(() => {
      child.stdout.end(stdout);
      child.stderr.end();
      child.emit('close', 0);
    });

    return child;
  });
}

describe('codexAgent', () => {
  test('name is codex', () => {
    expect(codexAgent.name).toBe('codex');
  });

  test('runEdit invokes streamSubprocess with `codex exec <prompt>` and no transformer', async () => {
    vi.mocked(streamSubprocess).mockResolvedValue(0);
    const code = await codexAgent.runEdit({
      prompt: 'do the thing',
      cwd: '/tmp/x',
      logPath: '/tmp/x/edit.log',
    });

    expect(code).toBe(0);
    const call = vi.mocked(streamSubprocess).mock.calls.at(-1)?.[0];
    expect(call?.cmd).toEqual(['codex', 'exec', 'do the thing']);
    expect(call?.cwd).toBe('/tmp/x');
    expect(call?.transformer).toBeUndefined();
  });

  test('runReview delegates to runCodexReview and renames the result field', async () => {
    vi.mocked(runCodexReview).mockResolvedValue({ code: 0, reviewText: 'looks good' });
    const result = await codexAgent.runReview({
      prompt: 'review the diff',
      cwd: '/tmp/x',
      logPath: '/tmp/x/review.log',
      outputPath: '/tmp/x/review.txt',
    });
    expect(result).toEqual({ code: 0, text: 'looks good' });
    expect(runCodexReview).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'review the diff',
        outputPath: '/tmp/x/review.txt',
        logPath: '/tmp/x/review.log',
        cwd: '/tmp/x',
      }),
    );
  });

  test('runJson defaults the subprocess cwd to the repo root', async () => {
    mockCodexJsonSpawn('thinking\n{"ok":true}\n');

    const result = await codexAgent.runJson({
      systemPrompt: 'system',
      userPrompt: 'user',
    });

    expect(result).toEqual({ ok: true });
    expect(spawnMock).toHaveBeenCalledWith('codex', ['exec', 'system\n\n---\n\nuser'], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });
});

describe('extractLastJsonObject', () => {
  test('returns the only object in clean stdout', () => {
    expect(extractLastJsonObject('{"a": 1}')).toBe('{"a": 1}');
  });

  test('picks the last valid object when several are present', () => {
    const stdout = `noise here\n{"first": true}\nmore noise\n{"second": "win"}\ntrailing`;
    expect(extractLastJsonObject(stdout)).toBe('{"second": "win"}');
  });

  test('respects braces inside string literals', () => {
    const stdout = `prefix\n{"description": "hello { world }", "ok": true}\nsuffix`;
    expect(extractLastJsonObject(stdout)).toBe('{"description": "hello { world }", "ok": true}');
  });

  test('returns the outer object when it contains nested decision objects', () => {
    const stdout =
      'codex output\n{"operations":[{"op":"reorder","order":["a"]}],"reasoning":"x"}\n';
    expect(extractLastJsonObject(stdout)).toBe(
      '{"operations":[{"op":"reorder","order":["a"]}],"reasoning":"x"}',
    );
  });

  test('returns null when no parseable JSON object is present', () => {
    expect(extractLastJsonObject('just plain text, no braces here')).toBeNull();
    expect(extractLastJsonObject('{ unbalanced')).toBeNull();
  });

  test('skips unparseable candidates and finds an earlier valid one', () => {
    // The final `{` is part of an unbalanced fragment — the earlier balanced
    // object should still be returned.
    const stdout = 'before {"good": "value"} and then {broken';
    expect(extractLastJsonObject(stdout)).toBe('{"good": "value"}');
  });
});
