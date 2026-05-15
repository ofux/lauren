import { spawn } from 'node:child_process';

import { REPO } from '../core/paths.js';
import { runCodexReview } from '../proc/codex.js';
import { streamSubprocess } from '../proc/stream.js';
import type {
  CodingAgent,
  EditTaskInput,
  JsonTaskInput,
  ReviewTaskInput,
  ReviewTaskResult,
} from './types.js';

function codexExecCommand(prompt: string): string[] {
  return ['codex', 'exec', prompt];
}

export class CodexAborted extends Error {
  constructor() {
    super('codex subprocess aborted');
    this.name = 'CodexAborted';
  }
}

/**
 * Scan `text` for the last valid outer balanced JSON object (`{…}`). Respects
 * string literals and escape sequences so braces inside strings don't
 * confuse the matcher. Returns the substring (without surrounding text) or
 * null if no parseable block is found.
 *
 * Used by the codex adapter to extract a JSON decision from `codex exec`
 * stdout, which mixes progress lines with the final assistant response.
 */
export function extractLastJsonObject(text: string): string | null {
  let last: string | null = null;
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue;
    const end = findJsonObjectEnd(text, start);
    if (end === null) continue;
    const candidate = text.slice(start, end + 1);
    try {
      JSON.parse(candidate);
      last = candidate;
      start = end;
    } catch {
      // Keep scanning: a later nested/standalone object may still be valid.
    }
  }
  return last;
}

function findJsonObjectEnd(text: string, start: number): number | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

interface CapturedRun {
  code: number;
  stdout: string;
  stderr: string;
  aborted: boolean;
}

async function spawnAndCapture(
  cmd: string[],
  opts: { cwd?: string; signal?: AbortSignal },
): Promise<CapturedRun> {
  const [program, ...rest] = cmd;
  if (!program) throw new Error('empty codex command');
  if (opts.signal?.aborted) throw new CodexAborted();

  return new Promise<CapturedRun>((resolve, reject) => {
    const cwd = opts.cwd ?? REPO;
    const child = spawn(program, rest, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let killTimer: NodeJS.Timeout | null = null;
    const onAbort = (): void => {
      aborted = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // child may already have exited
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 2000);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', (err) => {
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code: code ?? 1, stdout, stderr, aborted });
    });
  });
}

export const codexAgent: CodingAgent = {
  name: 'codex',

  async runEdit(input: EditTaskInput): Promise<number> {
    const sinkArg = input.sink ?? undefined;
    return streamSubprocess({
      cmd: codexExecCommand(input.prompt),
      logPath: input.logPath,
      cwd: input.cwd,
      ...(sinkArg !== undefined ? { sink: sinkArg } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  },

  async runReview(input: ReviewTaskInput): Promise<ReviewTaskResult> {
    const sinkArg = input.sink ?? undefined;
    const { code, reviewText } = await runCodexReview({
      prompt: input.prompt,
      outputPath: input.outputPath,
      logPath: input.logPath,
      cwd: input.cwd,
      ...(sinkArg !== undefined ? { sink: sinkArg } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    return { code, text: reviewText };
  },

  async runJson(input: JsonTaskInput): Promise<unknown> {
    // codex doesn't have a streaming JSON output mode, so combine prompts and
    // capture stdout — then extract the last JSON object the agent emitted.
    const combined = `${input.systemPrompt}\n\n---\n\n${input.userPrompt}`;
    const result = await spawnAndCapture(['codex', 'exec', combined], {
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (result.aborted) throw new CodexAborted();
    if (result.code !== 0) {
      throw new Error(`codex exited ${result.code}: ${result.stderr.trim().slice(0, 400)}`);
    }
    const block = extractLastJsonObject(result.stdout);
    if (block === null) {
      throw new Error(`codex did not return a JSON object\n---\n${result.stdout.slice(0, 600)}`);
    }
    return JSON.parse(block);
  },
};
