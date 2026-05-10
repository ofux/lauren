import { promises as fs } from 'node:fs';

import { DEFAULT_CONTEXT, displayPath, type LaurenContext } from './paths.js';

export type MergeMode = 'auto' | 'github-pr';

export interface LaurenConfig {
  version: 1;
  dev_branch: string;
  merge_mode: MergeMode;
}

export const DEFAULT_CONFIG: LaurenConfig = {
  version: 1,
  dev_branch: 'main',
  merge_mode: 'auto',
};

export class LaurenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaurenConfigError';
  }
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LaurenConfigError(`${label} must be an object`);
  }
}

function parseConfig(raw: unknown, configPath: string): LaurenConfig {
  const label = displayPath(configPath);
  assertObject(raw, label);
  if (raw.version !== 1) {
    throw new LaurenConfigError(`${label}: unsupported version ${JSON.stringify(raw.version)}`);
  }

  const dev_branch =
    typeof raw.dev_branch === 'string' && raw.dev_branch.trim().length > 0
      ? raw.dev_branch.trim()
      : DEFAULT_CONFIG.dev_branch;

  let merge_mode: MergeMode = DEFAULT_CONFIG.merge_mode;
  if (raw.merge_mode !== undefined) {
    if (raw.merge_mode !== 'auto' && raw.merge_mode !== 'github-pr') {
      throw new LaurenConfigError(
        `${label}: merge_mode must be "auto" or "github-pr" (got ${JSON.stringify(raw.merge_mode)})`,
      );
    }
    merge_mode = raw.merge_mode;
  }

  return { version: 1, dev_branch, merge_mode };
}

/**
 * Load `.lauren/config.json`, returning {@link DEFAULT_CONFIG} when the file
 * doesn't exist. Throws {@link LaurenConfigError} on malformed JSON or
 * unsupported values.
 */
export async function readLaurenConfig(
  context: LaurenContext = DEFAULT_CONTEXT,
): Promise<LaurenConfig> {
  const configPath = context.configPath;
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...DEFAULT_CONFIG };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LaurenConfigError(`${displayPath(configPath)}: malformed JSON: ${msg}`);
  }
  return parseConfig(parsed, configPath);
}
