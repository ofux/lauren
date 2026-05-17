import { promises as fs } from 'node:fs';
import path from 'node:path';

import { gitAddPaths, gitCommit, hasAnyCommits } from './proc/git.js';

const LAUREN_IGNORE_LINE = '.lauren/';

async function ensureLaurenIgnoreLine(gitignorePath: string): Promise<void> {
  let existing: string;
  try {
    existing = await fs.readFile(gitignorePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.writeFile(gitignorePath, `${LAUREN_IGNORE_LINE}\n`, 'utf8');
      return;
    }
    throw err;
  }
  const lines = existing.split('\n').map((l) => l.trim());
  if (lines.includes(LAUREN_IGNORE_LINE)) return;
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  await fs.writeFile(gitignorePath, `${existing}${sep}${LAUREN_IGNORE_LINE}\n`, 'utf8');
}

/**
 * If `cwd` is a git repo with no commits yet (unborn branch), create an
 * initial commit so worktree-based work has something to anchor to.
 *
 * The commit adds a `.gitignore` containing `.lauren/` — both a sensible
 * default and a breadcrumb of why this commit exists. If `.gitignore`
 * already exists, the `.lauren/` line is appended only when missing.
 *
 * Returns true if a commit was created, false if the repo already had
 * commits. Any other untracked files in the working tree are left alone.
 */
export async function ensureInitialCommit(cwd: string): Promise<boolean> {
  if (hasAnyCommits(cwd)) return false;
  const gitignorePath = path.join(cwd, '.gitignore');
  await ensureLaurenIgnoreLine(gitignorePath);
  gitAddPaths(cwd, ['.gitignore']);
  const r = gitCommit('Initial commit', { capture: true, cwd });
  if (r.code !== 0) {
    throw new Error(`git commit (initial) exited ${r.code}: ${r.stderr.trim()}`);
  }
  return true;
}
