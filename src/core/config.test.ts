import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { DEFAULT_AGENTS } from '../agents/types.js';
import { DEFAULT_CONFIG, LaurenConfigError, readLaurenConfig } from './config.js';
import type { LaurenContext } from './paths.js';

async function makeContext(): Promise<{ context: LaurenContext; configPath: string }> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'lauren-config-'));
  const configPath = path.join(dir, 'config.json');
  const context = {
    repo: dir,
    laurenDir: dir,
    logRoot: dir,
    plansDir: dir,
    worktreesRoot: dir,
    configPath,
    plansStatePath: dir,
    plansStateLockPath: dir,
    vibeLockPath: dir,
    vibePidPath: dir,
    docsDir: dir,
    prdPath: dir,
    archPath: dir,
    testingPath: dir,
  };
  return { context, configPath };
}

describe('readLaurenConfig', () => {
  test('returns defaults when the file is missing', async () => {
    const { context } = await makeContext();
    const cfg = await readLaurenConfig(context);
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  test('parses dev_branch and merge_mode overrides', async () => {
    const { context, configPath } = await makeContext();
    await fs.writeFile(
      configPath,
      JSON.stringify({ version: 1, dev_branch: 'develop', merge_mode: 'github-pr' }),
    );
    const cfg = await readLaurenConfig(context);
    expect(cfg.dev_branch).toBe('develop');
    expect(cfg.merge_mode).toBe('github-pr');
  });

  test('rejects malformed JSON', async () => {
    const { context, configPath } = await makeContext();
    await fs.writeFile(configPath, '{ not json');
    await expect(readLaurenConfig(context)).rejects.toBeInstanceOf(LaurenConfigError);
  });

  test('rejects unsupported version', async () => {
    const { context, configPath } = await makeContext();
    await fs.writeFile(configPath, JSON.stringify({ version: 99 }));
    await expect(readLaurenConfig(context)).rejects.toBeInstanceOf(LaurenConfigError);
  });

  test('rejects unknown merge_mode', async () => {
    const { context, configPath } = await makeContext();
    await fs.writeFile(configPath, JSON.stringify({ version: 1, merge_mode: 'rebase' }));
    await expect(readLaurenConfig(context)).rejects.toBeInstanceOf(LaurenConfigError);
  });

  test('falls back to default dev_branch when empty', async () => {
    const { context, configPath } = await makeContext();
    await fs.writeFile(configPath, JSON.stringify({ version: 1, dev_branch: '' }));
    const cfg = await readLaurenConfig(context);
    expect(cfg.dev_branch).toBe(DEFAULT_CONFIG.dev_branch);
  });

  test('returns default agents when the agents block is missing', async () => {
    const { context, configPath } = await makeContext();
    await fs.writeFile(configPath, JSON.stringify({ version: 1 }));
    const cfg = await readLaurenConfig(context);
    expect(cfg.agents).toEqual(DEFAULT_AGENTS);
  });

  test('merges a partial agents block over the defaults', async () => {
    const { context, configPath } = await makeContext();
    await fs.writeFile(
      configPath,
      JSON.stringify({ version: 1, agents: { implement: 'codex', fix: 'codex' } }),
    );
    const cfg = await readLaurenConfig(context);
    expect(cfg.agents).toEqual({
      ...DEFAULT_AGENTS,
      implement: 'codex',
      fix: 'codex',
    });
  });

  test('rejects an unknown agent name', async () => {
    const { context, configPath } = await makeContext();
    await fs.writeFile(configPath, JSON.stringify({ version: 1, agents: { implement: 'gpt5' } }));
    await expect(readLaurenConfig(context)).rejects.toMatchObject({
      name: 'LaurenConfigError',
      message: expect.stringContaining('agents.implement'),
    });
  });

  test('rejects an unknown agents role', async () => {
    const { context, configPath } = await makeContext();
    await fs.writeFile(configPath, JSON.stringify({ version: 1, agents: { plan: 'claude' } }));
    await expect(readLaurenConfig(context)).rejects.toMatchObject({
      name: 'LaurenConfigError',
      message: expect.stringContaining('unknown role'),
    });
  });

  test('rejects a non-object agents value', async () => {
    const { context, configPath } = await makeContext();
    await fs.writeFile(configPath, JSON.stringify({ version: 1, agents: 'claude' }));
    await expect(readLaurenConfig(context)).rejects.toBeInstanceOf(LaurenConfigError);
  });
});
