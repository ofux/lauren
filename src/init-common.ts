import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface InstallAsset {
  /** Path relative to the install base directory. */
  relpath: string;
  content: string;
}

export interface InstallAssetsOptions {
  assets: readonly InstallAsset[];
  baseDir: string;
  force: boolean;
  /** Printed after a successful install (no leading newline required). */
  successMessage: string;
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
}

export async function installAssets(opts: InstallAssetsOptions): Promise<number> {
  const { assets, baseDir, force, successMessage, out, err } = opts;

  if (!force) {
    const collisions: string[] = [];
    for (const asset of assets) {
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

  for (const asset of assets) {
    const full = path.join(baseDir, asset.relpath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, asset.content, 'utf8');
    out.write(`wrote ${full}\n`);
  }
  out.write(`\n${successMessage}\n`);
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
