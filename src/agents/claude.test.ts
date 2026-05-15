import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { runClaudeOneshotJson } from '../proc/claude.js';
import { streamSubprocess } from '../proc/stream.js';
import { claudeAgent } from './claude.js';

vi.mock('../proc/stream.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../proc/stream.js')>();
  return { ...actual, streamSubprocess: vi.fn() };
});

vi.mock('../proc/claude.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../proc/claude.js')>();
  return { ...actual, runClaudeOneshotJson: vi.fn() };
});

describe('claudeAgent', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(tmpdir(), 'claude-agent-'));
    vi.mocked(streamSubprocess).mockReset();
    vi.mocked(runClaudeOneshotJson).mockReset();
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  test('name is claude', () => {
    expect(claudeAgent.name).toBe('claude');
  });

  test('runEdit invokes streamSubprocess with the claude print command', async () => {
    vi.mocked(streamSubprocess).mockResolvedValue(0);
    const logPath = path.join(workDir, 'edit.log');

    const code = await claudeAgent.runEdit({
      prompt: 'do the thing',
      cwd: workDir,
      logPath,
    });

    expect(code).toBe(0);
    expect(streamSubprocess).toHaveBeenCalledTimes(1);
    const call = vi.mocked(streamSubprocess).mock.calls[0]?.[0];
    expect(call?.cmd).toEqual([
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      'do the thing',
    ]);
    expect(call?.cwd).toBe(workDir);
    expect(call?.logPath).toBe(logPath);
    expect(call?.transformer).toBeDefined();
  });

  test('runReview wipes prior output, then writes the parsed final message', async () => {
    const outputPath = path.join(workDir, 'review.message.txt');
    const logPath = path.join(workDir, 'review.log');
    await fs.writeFile(outputPath, 'stale content', 'utf8');

    // streamSubprocess writes the raw stream-json log file. Simulate that.
    vi.mocked(streamSubprocess).mockImplementation(async (opts) => {
      await fs.writeFile(
        opts.logPath,
        `# claude -p ...\n# started: 2026-05-14T00:00:00Z\n\n` +
          `${JSON.stringify({ type: 'system', subtype: 'init', model: 'opus-4.7' })}\n` +
          `${JSON.stringify({
            type: 'result',
            is_error: false,
            result: 'review body here\nmore lines',
          })}\n` +
          `\n# exit: 0\n`,
        'utf8',
      );
      return 0;
    });

    const { code, text } = await claudeAgent.runReview({
      prompt: 'review the diff',
      cwd: workDir,
      logPath,
      outputPath,
    });

    expect(code).toBe(0);
    expect(text).toBe('review body here\nmore lines');
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('review body here\nmore lines');
  });

  test('runReview returns empty text and writes nothing when claude exits non-zero', async () => {
    const outputPath = path.join(workDir, 'review.message.txt');
    const logPath = path.join(workDir, 'review.log');
    vi.mocked(streamSubprocess).mockResolvedValue(1);

    const { code, text } = await claudeAgent.runReview({
      prompt: 'review the diff',
      cwd: workDir,
      logPath,
      outputPath,
    });

    expect(code).toBe(1);
    expect(text).toBe('');
    await expect(fs.access(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('runJson delegates to runClaudeOneshotJson', async () => {
    vi.mocked(runClaudeOneshotJson).mockResolvedValue({ kind: 'insert', position: 0 });
    const result = await claudeAgent.runJson({
      systemPrompt: 'system',
      userPrompt: 'user',
    });
    expect(result).toEqual({ kind: 'insert', position: 0 });
    expect(runClaudeOneshotJson).toHaveBeenCalledWith({
      systemPrompt: 'system',
      userPrompt: 'user',
    });
  });
});
