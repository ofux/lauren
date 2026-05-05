import { spawn, spawnSync } from 'node:child_process';

import { REPO } from '../core/paths.js';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runSync(cmd: string[], cwd: string = REPO): RunResult {
  const [program, ...args] = cmd;
  if (!program) throw new Error('empty git command');
  const r = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
  });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function workingTreeDirty(cwd: string = REPO): boolean {
  const r = runSync(['git', 'status', '--porcelain'], cwd);
  if (r.code !== 0) {
    throw new Error(`git status --porcelain exited ${r.code}: ${r.stderr.trim()}`);
  }
  return r.stdout.trim().length > 0;
}

export function gitLogSubjects(cwd: string = REPO): string[] {
  const r = runSync(['git', 'log', '--pretty=%s'], cwd);
  if (r.code !== 0) {
    throw new Error(`git log --pretty=%s exited ${r.code}: ${r.stderr.trim()}`);
  }
  return r.stdout.split('\n').filter((l) => l.length > 0);
}

export function gitAddAll(): void {
  const r = runSync(['git', 'add', '-A']);
  if (r.code !== 0) {
    throw new Error(`git add -A exited ${r.code}: ${r.stderr.trim()}`);
  }
}

export interface GitCommitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `git commit -m <message>`. When `capture` is true, stdio is captured
 * (used by the live TUI to keep its display clean and to extract a tail
 * line for failure messages). When false, stdio inherits and output goes
 * straight to the parent terminal (used by `vibe --dry-run` style flows).
 */
export function gitCommit(
  message: string,
  opts: { capture: boolean } = { capture: true },
): GitCommitResult {
  if (opts.capture) {
    return runSync(['git', 'commit', '-m', message]);
  }
  // We need to inherit stdio but still get an exit code synchronously —
  // spawnSync with stdio: 'inherit' does both.
  const r = spawnSync('git', ['commit', '-m', message], {
    cwd: REPO,
    stdio: 'inherit',
  });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: '', stderr: '' };
}

/**
 * Async git status check used in async contexts where blocking the event
 * loop with spawnSync isn't desired.
 */
export async function workingTreeDirtyAsync(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['status', '--porcelain'], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c.toString()));
    child.stderr.on('data', (c) => (err += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git status --porcelain exited ${code}: ${err.trim()}`));
        return;
      }
      resolve(out.trim().length > 0);
    });
  });
}
