import { promises as fs } from 'node:fs';

import { runClaudeOneshotJson } from '../proc/claude.js';
import { streamSubprocess } from '../proc/stream.js';
import { formatClaudeStreamLine, parseClaudeOneshotResult } from '../util/streamJson.js';
import type {
  CodingAgent,
  EditTaskInput,
  JsonTaskInput,
  ReviewTaskInput,
  ReviewTaskResult,
} from './types.js';

function claudePrintCommand(prompt: string): string[] {
  return ['claude', '-p', '--output-format', 'stream-json', '--verbose', prompt];
}

/**
 * Read the raw stdout/stderr captured by {@link streamSubprocess} from its
 * log file, skipping the leading `# …` header lines and the trailing
 * `# exit: …` footer. The log mixes stdout and stderr; the JSON parser in
 * {@link parseClaudeOneshotResult} silently skips non-JSON lines so stderr
 * lines pass through harmlessly.
 */
async function readStreamLog(logPath: string): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(logPath, 'utf8');
  } catch {
    return '';
  }
  return raw;
}

export const claudeAgent: CodingAgent = {
  name: 'claude',

  async runEdit(input: EditTaskInput): Promise<number> {
    const sinkArg = input.sink ?? undefined;
    return streamSubprocess({
      cmd: claudePrintCommand(input.prompt),
      logPath: input.logPath,
      cwd: input.cwd,
      ...(sinkArg !== undefined ? { sink: sinkArg } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      transformer: formatClaudeStreamLine,
    });
  },

  async runReview(input: ReviewTaskInput): Promise<ReviewTaskResult> {
    // Wipe any prior output so callers can't read stale content on failure.
    // Mirrors runCodexReview's contract.
    await fs.rm(input.outputPath, { force: true });

    const sinkArg = input.sink ?? undefined;
    const code = await streamSubprocess({
      cmd: claudePrintCommand(input.prompt),
      logPath: input.logPath,
      cwd: input.cwd,
      ...(sinkArg !== undefined ? { sink: sinkArg } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      transformer: formatClaudeStreamLine,
    });

    if (code !== 0) {
      return { code, text: '' };
    }

    let text = '';
    try {
      const raw = await readStreamLog(input.logPath);
      text = parseClaudeOneshotResult(raw);
    } catch {
      // claude reported is_error in its result event; surface as empty review
      // (the executor short-circuits the fix step on empty review).
      text = '';
    }

    if (text.trim().length > 0) {
      await fs.writeFile(input.outputPath, text, 'utf8');
    }
    return { code, text };
  },

  async runJson(input: JsonTaskInput): Promise<unknown> {
    return runClaudeOneshotJson({
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  },
};
