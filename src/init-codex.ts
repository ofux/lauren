import os from 'node:os';
import path from 'node:path';

import { CODEX_ASSETS } from './codex-assets.js';
import { resolveRepoRoot } from './core/paths.js';
import { installAssets } from './init-common.js';

export interface InitCodexOptions {
  force: boolean;
  global: boolean;
  cwd?: string;
  home?: string;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
}

export async function cmdInitCodex(opts: InitCodexOptions): Promise<number> {
  const baseDir = opts.global
    ? path.join(opts.home ?? os.homedir(), '.agents')
    : path.join(resolveRepoRoot(opts.cwd ?? process.cwd()), '.agents');

  return installAssets({
    assets: CODEX_ASSETS,
    baseDir,
    force: opts.force,
    successMessage: 'Restart your Codex CLI session to load the `lauren` skill.',
    out: opts.out ?? process.stdout,
    err: opts.err ?? process.stderr,
  });
}
