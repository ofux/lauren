import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { LaurenContext } from './paths.js';
import { resolveWorkspaceRepos, WorkspaceConfigError } from './workspace.js';

function makeContext(repo: string): LaurenContext {
  const laurenDir = path.join(repo, '.lauren');
  const docsDir = path.join(repo, 'docs');
  return {
    repo,
    laurenDir,
    logRoot: path.join(laurenDir, 'logs'),
    plansDir: path.join(laurenDir, 'plans'),
    todoPath: path.join(laurenDir, 'todo.json'),
    lockPath: path.join(laurenDir, 'todo.json.lock'),
    vibeLockPath: path.join(laurenDir, 'vibe.lock'),
    vibePidPath: path.join(laurenDir, 'vibe.pid'),
    inboxPath: path.join(laurenDir, 'inbox.json'),
    inboxLockPath: path.join(laurenDir, 'inbox.json.lock'),
    docsDir,
    prdPath: path.join(docsDir, 'PRD.md'),
    archPath: path.join(docsDir, 'ARCHITECTURE.md'),
    testingPath: path.join(docsDir, 'TESTING.md'),
  };
}

async function writeWorkspaceConfig(repo: string, body: unknown): Promise<void> {
  const laurenDir = path.join(repo, '.lauren');
  await fs.mkdir(laurenDir, { recursive: true });
  await fs.writeFile(path.join(laurenDir, 'workspace.json'), JSON.stringify(body), 'utf8');
}

async function makeFakeRepo(workspaceRoot: string, relPath: string): Promise<void> {
  const root = path.join(workspaceRoot, relPath);
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
}

describe('resolveWorkspaceRepos', () => {
  let tmpDir: string;
  let context: LaurenContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lauren-workspace-'));
    context = makeContext(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('falls back to the context repo when no workspace config exists', async () => {
    await makeFakeRepo(tmpDir, '.');
    await expect(resolveWorkspaceRepos([], context)).resolves.toEqual([
      { name: path.basename(tmpDir), path: '.', root: tmpDir },
    ]);
  });

  test('auto-discovers sub-repos when the parent is not a git repo and no config exists', async () => {
    await makeFakeRepo(tmpDir, 'fl-backend');
    await makeFakeRepo(tmpDir, 'frontend-v3');
    // A non-repo sibling and a hidden directory should be ignored.
    await fs.mkdir(path.join(tmpDir, 'not-a-repo'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, '.hidden', '.git'), { recursive: true });

    const resolved = await resolveWorkspaceRepos([], context);
    expect(resolved).toEqual([
      { name: 'fl-backend', path: 'fl-backend', root: path.join(tmpDir, 'fl-backend') },
      { name: 'frontend-v3', path: 'frontend-v3', root: path.join(tmpDir, 'frontend-v3') },
    ]);
  });

  test('rejects fallback when neither a git repo nor any sub-repos are present', async () => {
    await expect(resolveWorkspaceRepos([], context)).rejects.toThrow(
      /is not a git repository and no sub-repositories were found/,
    );
  });

  test('resolves configured repos and filters requested targets', async () => {
    await writeWorkspaceConfig(tmpDir, {
      version: 1,
      repos: [
        { name: 'backend', path: 'backend' },
        { name: 'frontend', path: 'apps/frontend' },
      ],
    });
    await makeFakeRepo(tmpDir, 'backend');
    await makeFakeRepo(tmpDir, 'apps/frontend');

    await expect(resolveWorkspaceRepos(['frontend'], context)).resolves.toEqual([
      {
        name: 'frontend',
        path: path.join('apps', 'frontend'),
        root: path.join(tmpDir, 'apps', 'frontend'),
      },
    ]);
  });

  test('rejects unknown targets', async () => {
    await writeWorkspaceConfig(tmpDir, {
      version: 1,
      repos: [{ name: 'backend', path: 'backend' }],
    });
    await makeFakeRepo(tmpDir, 'backend');

    await expect(resolveWorkspaceRepos(['frontend'], context)).rejects.toThrow(
      /unknown repo 'frontend'/,
    );
  });

  test('rejects configured repos whose path does not exist', async () => {
    await writeWorkspaceConfig(tmpDir, {
      version: 1,
      repos: [{ name: 'backend', path: 'backend' }],
    });

    await expect(resolveWorkspaceRepos([], context)).rejects.toThrow(
      /repo 'backend' path 'backend' does not exist/,
    );
  });

  test('rejects configured repos that are not git repositories', async () => {
    await writeWorkspaceConfig(tmpDir, {
      version: 1,
      repos: [{ name: 'backend', path: 'backend' }],
    });
    await fs.mkdir(path.join(tmpDir, 'backend'), { recursive: true });

    await expect(resolveWorkspaceRepos([], context)).rejects.toThrow(
      /repo 'backend'.*is not a git repository/,
    );
  });

  test('rejects configured repos whose path is not a directory', async () => {
    await writeWorkspaceConfig(tmpDir, {
      version: 1,
      repos: [{ name: 'backend', path: 'backend' }],
    });
    await fs.writeFile(path.join(tmpDir, 'backend'), 'not-a-dir', 'utf8');

    await expect(resolveWorkspaceRepos([], context)).rejects.toThrow(
      /repo 'backend' path 'backend' is not a directory/,
    );
  });

  test('rejects configured repo paths outside the workspace root', async () => {
    await writeWorkspaceConfig(tmpDir, {
      version: 1,
      repos: [{ name: 'outside', path: '..' }],
    });

    await expect(resolveWorkspaceRepos([], context)).rejects.toBeInstanceOf(WorkspaceConfigError);
  });

  test('rejects configured repos that resolve to the same path', async () => {
    await writeWorkspaceConfig(tmpDir, {
      version: 1,
      repos: [
        { name: 'api', path: 'services/api' },
        { name: 'api-alias', path: './services/api' },
      ],
    });

    await expect(resolveWorkspaceRepos([], context)).rejects.toThrow(
      /repo 'api-alias' resolves to the same path as repo 'api'/,
    );
  });
});
