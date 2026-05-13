import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLAUDE_ASSETS } from './claude-assets.js';
import { resolveRepoRoot } from './core/paths.js';

export interface InitClaudeOptions {
  force: boolean;
  global: boolean;
  cwd?: string;
  home?: string;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
}

export async function cmdInitClaude(opts: InitClaudeOptions): Promise<number> {
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;
  const baseDir = opts.global
    ? path.join(opts.home ?? os.homedir(), '.claude')
    : path.join(resolveRepoRoot(opts.cwd ?? process.cwd()), '.claude');

  if (!opts.force) {
    const collisions: string[] = [];
    for (const asset of CLAUDE_ASSETS) {
      const full = path.join(baseDir, asset.relpath);
      if (await fileExists(full)) collisions.push(full);
    }
    if (collisions.length > 0) {
      const noun = collisions.length === 1 ? 'file' : 'files';
      const verb = collisions.length === 1 ? 'exists' : 'exist';
      err.write(`error: target ${noun} already ${verb}:\n`);
      for (const c of collisions) err.write(`  - ${c}\n`);
      err.write('Re-run with --force to overwrite.\n');
      return 1;
    }
  }

  for (const asset of CLAUDE_ASSETS) {
    const full = path.join(baseDir, asset.relpath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, asset.content, 'utf8');
    out.write(`wrote ${full}\n`);
  }
  out.write(
    '\nRestart your Claude Code session to load the `lauren` skill and the `/lauren` slash command.\n',
  );
  return 0;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
