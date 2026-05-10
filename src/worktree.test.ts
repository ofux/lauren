import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_CONFIG } from './core/config.js';
import { worktreePath, worktreeRootPath } from './core/paths.js';
import { type Plan, planFilePath } from './core/types.js';
import { type ResolvedWorkspaceRepo, resolveWorkspaceRepos } from './core/workspace.js';
import { gitWorktreeAdd, gitWorktreeRemove } from './proc/git.js';
import { setupPlanWorktrees } from './worktree.js';

vi.mock('./core/workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./core/workspace.js')>();
  return {
    ...actual,
    resolveWorkspaceRepos: vi.fn(),
  };
});

vi.mock('./proc/git.js', () => ({
  gitDeleteBranch: vi.fn(),
  gitWorktreeAdd: vi.fn(),
  gitWorktreeRemove: vi.fn(),
}));

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    slug: 'worktree-path-rewrite',
    title: 'Worktree path rewrite',
    path: '.lauren/plans/worktree-path-rewrite.md',
    target_repos: [],
    status: 'ready',
    cancel_requested: false,
    created_at: '2026-05-08T12:00:00Z',
    started_at: null,
    finished_at: null,
    failure: null,
    steps: null,
    ...overrides,
  };
}

afterEach(async () => {
  vi.mocked(resolveWorkspaceRepos).mockReset();
  vi.mocked(gitWorktreeAdd).mockReset();
  vi.mocked(gitWorktreeRemove).mockReset();
  await fs.rm(worktreeRootPath('worktree-path-rewrite'), { recursive: true, force: true });
  await fs.rm(planFilePath(makePlan()), { force: true });
});

describe('setupPlanWorktrees', () => {
  test('prunes stale worktree registrations even when the directory is already gone', async () => {
    const plan = makePlan();
    const repos: ResolvedWorkspaceRepo[] = [{ name: 'app', path: '.', root: '/workspace/app' }];
    vi.mocked(resolveWorkspaceRepos).mockResolvedValue(repos);

    await fs.mkdir(path.dirname(planFilePath(plan)), { recursive: true });
    await fs.writeFile(planFilePath(plan), '# Stale worktree\n', 'utf8');

    await setupPlanWorktrees(plan, DEFAULT_CONFIG);

    expect(gitWorktreeRemove).toHaveBeenCalledWith({
      repoRoot: '/workspace/app',
      worktreePath: worktreeRootPath(plan.slug),
    });
    expect(gitWorktreeAdd).toHaveBeenCalledWith({
      repoRoot: '/workspace/app',
      worktreePath: worktreeRootPath(plan.slug),
      branch: 'lauren/worktree-path-rewrite',
      baseBranch: DEFAULT_CONFIG.dev_branch,
    });
  });

  test('rewrites multi-repo paths to match worktree-relative directories', async () => {
    const plan = makePlan();
    const repos: ResolvedWorkspaceRepo[] = [
      { name: 'frontend', path: 'apps/frontend', root: '/workspace/apps/frontend' },
      { name: 'api', path: 'services/api', root: '/workspace/services/api' },
    ];
    vi.mocked(resolveWorkspaceRepos).mockResolvedValue(repos);

    await fs.mkdir(path.dirname(planFilePath(plan)), { recursive: true });
    await fs.writeFile(planFilePath(plan), '# Worktree path rewrite\n', 'utf8');

    const ctx = await setupPlanWorktrees(plan, DEFAULT_CONFIG);

    expect(ctx.rootCwd).toBe(worktreeRootPath(plan.slug));
    expect(ctx.rewrittenRepos).toEqual([
      { name: 'frontend', path: 'frontend', root: worktreePath(plan.slug, 'frontend') },
      { name: 'api', path: 'api', root: worktreePath(plan.slug, 'api') },
    ]);
    expect(gitWorktreeAdd).toHaveBeenCalledWith({
      repoRoot: '/workspace/apps/frontend',
      worktreePath: worktreePath(plan.slug, 'frontend'),
      branch: 'lauren/worktree-path-rewrite',
      baseBranch: DEFAULT_CONFIG.dev_branch,
    });
    await expect(
      fs.readFile(path.join(ctx.rootCwd, '.lauren', 'plans', `${plan.slug}.md`), 'utf8'),
    ).resolves.toBe('# Worktree path rewrite\n');
  });
});
