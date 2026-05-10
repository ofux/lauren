import { spawnSync } from 'node:child_process';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runSync(cmd: string[], cwd: string): RunResult {
  const [program, ...args] = cmd;
  if (!program) throw new Error('empty gh command');
  const r = spawnSync(program, args, { cwd, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export class GhError extends Error {
  readonly code: number;
  readonly stderr: string;
  constructor(message: string, code: number, stderr: string) {
    super(message);
    this.name = 'GhError';
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Open a PR via `gh pr create`. cwd must be inside the git repo whose
 * branch should be pushed; the branch must already be pushed to origin.
 * Returns the PR URL on success.
 */
export function ghPrCreate(args: {
  cwd: string;
  base: string;
  head: string;
  title: string;
  body: string;
}): string {
  const r = runSync(
    [
      'gh',
      'pr',
      'create',
      '--base',
      args.base,
      '--head',
      args.head,
      '--title',
      args.title,
      '--body',
      args.body,
    ],
    args.cwd,
  );
  if (r.code !== 0) {
    throw new GhError(`gh pr create exited ${r.code}: ${r.stderr.trim()}`, r.code, r.stderr);
  }
  // gh prints the PR URL as the last non-empty stdout line.
  const lines = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const url = lines.length > 0 ? (lines[lines.length - 1] ?? '') : '';
  if (!/^https?:\/\//.test(url)) {
    throw new GhError(`gh pr create returned no URL: ${r.stdout.trim()}`, r.code, r.stderr);
  }
  return url;
}

export interface PrStatus {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  merged: boolean;
}

/**
 * Query PR state via `gh pr view --json state,mergedAt`. Returns a normalized
 * status. Throws {@link GhError} on subprocess failure or unparseable output.
 */
export function ghPrView(url: string, cwd: string): PrStatus {
  const r = runSync(['gh', 'pr', 'view', url, '--json', 'state,mergedAt'], cwd);
  if (r.code !== 0) {
    throw new GhError(`gh pr view exited ${r.code}: ${r.stderr.trim()}`, r.code, r.stderr);
  }
  let data: { state?: string; mergedAt?: string | null };
  try {
    data = JSON.parse(r.stdout) as { state?: string; mergedAt?: string | null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new GhError(`gh pr view returned malformed JSON: ${msg}`, r.code, r.stderr);
  }
  const state =
    data.state === 'OPEN' || data.state === 'CLOSED' || data.state === 'MERGED'
      ? data.state
      : 'OPEN';
  const merged =
    state === 'MERGED' || (typeof data.mergedAt === 'string' && data.mergedAt.length > 0);
  return { state, merged };
}
