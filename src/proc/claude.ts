import { spawn, spawnSync } from 'node:child_process';

import { REPO } from '../core/paths.js';
import { parseClaudeOneshotResult } from '../util/streamJson.js';

/**
 * Launch claude as an interactive TTY child process. stdin/stdout/stderr
 * inherit from the parent, so claude takes over the terminal and the user
 * types directly to it. Returns claude's exit code.
 */
export function runClaudeInteractive(args: {
  systemPrompt: string;
  name: string;
  userPrompt?: string;
}): number {
  const cmd = ['claude', '--name', args.name, '--append-system-prompt', args.systemPrompt];
  if (args.userPrompt !== undefined) {
    cmd.push(args.userPrompt);
  }
  const [program, ...rest] = cmd;
  if (!program) throw new Error('empty claude command');
  const r = spawnSync(program, rest, {
    cwd: REPO,
    stdio: 'inherit',
  });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

export class ClaudeAborted extends Error {
  constructor() {
    super('claude subprocess aborted');
    this.name = 'ClaudeAborted';
  }
}

/**
 * Run claude as a non-interactive one-shot expecting a single JSON object
 * as the final result. The system prompt is prepended to the user prompt.
 * Returns the parsed JSON. Throws on subprocess failure, empty output, or
 * invalid JSON.
 *
 * If `signal` is provided and aborts, the child is killed (SIGTERM, then
 * SIGKILL after 2s) and the call rejects with {@link ClaudeAborted}.
 */
export async function runClaudeOneshotJson(args: {
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
  cwd?: string;
}): Promise<unknown> {
  const combined = `${args.systemPrompt}\n\n---\n\n${args.userPrompt}`;
  const cmd = ['claude', '-p', '--output-format', 'stream-json', '--verbose', combined];
  const [program, ...rest] = cmd;
  if (!program) throw new Error('empty claude command');

  if (args.signal?.aborted) throw new ClaudeAborted();

  const cwd = args.cwd ?? REPO;
  const result = await new Promise<{
    code: number;
    stdout: string;
    stderr: string;
    aborted: boolean;
  }>((resolve, reject) => {
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
    if (args.signal) {
      if (args.signal.aborted) onAbort();
      else args.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', (err) => {
      if (killTimer) clearTimeout(killTimer);
      args.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer);
      args.signal?.removeEventListener('abort', onAbort);
      resolve({ code: code ?? 1, stdout, stderr, aborted });
    });
  });

  if (result.aborted) throw new ClaudeAborted();
  if (result.code !== 0) {
    throw new Error(`claude exited ${result.code}: ${result.stderr.trim().slice(0, 400)}`);
  }

  const finalText = parseClaudeOneshotResult(result.stdout);
  let s = finalText.trim();
  if (!s) {
    throw new Error('claude returned empty result');
  }

  // Strip code fences if present (```json ... ```). Handles both
  // multi-line fences and single-line ```{...}``` (no newline).
  if (s.startsWith('```')) {
    const firstNl = s.indexOf('\n');
    if (firstNl !== -1) {
      // Multi-line: drop the opening fence line entirely.
      s = s.slice(firstNl + 1);
    } else {
      // Single-line: drop just the opening ``` plus any language tag.
      s = s.slice(3).replace(/^[a-zA-Z0-9_-]*/, '');
    }
    if (s.endsWith('```')) s = s.slice(0, -3).trimEnd();
  }

  try {
    return JSON.parse(s);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`claude result is not valid JSON: ${msg}\n---\n${finalText.slice(0, 600)}`);
  }
}
