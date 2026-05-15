import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_CONFIG } from './core/config.js';
import { worktreePath, worktreeRootPath } from './core/paths.js';
import { type Plan, planFilePath } from './core/types.js';
import { type ResolvedWorkspaceRepo, resolveWorkspaceRepos } from './core/workspace.js';
import {
  gitDeleteBranch,
  gitWorktreeAdd,
  gitWorktreeRemove,
  workingTreeDirty,
} from './proc/git.js';
import { cleanupPlanWorktrees, setupPlanWorktrees } from './worktree.js';

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
  workingTreeDirty: vi.fn(),
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
  vi.mocked(gitDeleteBranch).mockReset();
  vi.mocked(gitWorktreeAdd).mockReset();
  vi.mocked(gitWorktreeRemove).mockReset();
  vi.mocked(workingTreeDirty).mockReset();
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

  test('rolls back already-created worktrees when a later repo fails', async () => {
    const plan = makePlan();
    const repos: ResolvedWorkspaceRepo[] = [
      { name: 'frontend', path: 'apps/frontend', root: '/workspace/apps/frontend' },
      { name: 'api', path: 'services/api', root: '/workspace/services/api' },
    ];
    vi.mocked(resolveWorkspaceRepos).mockResolvedValue(repos);

    await fs.mkdir(path.dirname(planFilePath(plan)), { recursive: true });
    await fs.writeFile(planFilePath(plan), '# Partial failure\n', 'utf8');

    // Two pre-loop best-effort removes (one per repo) plus a rollback
    // remove for the successfully-created frontend worktree.
    vi.mocked(gitWorktreeRemove).mockImplementation(() => undefined);
    vi.mocked(gitWorktreeAdd)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('git worktree add exited 128: fatal');
      });

    await expect(setupPlanWorktrees(plan, DEFAULT_CONFIG)).rejects.toThrow(
      'git worktree add exited 128: fatal',
    );

    expect(gitWorktreeRemove).toHaveBeenCalledWith({
      repoRoot: '/workspace/apps/frontend',
      worktreePath: worktreePath(plan.slug, 'frontend'),
    });
    expect(gitDeleteBranch).toHaveBeenCalledWith(
      'lauren/worktree-path-rewrite',
      '/workspace/apps/frontend',
    );
  });

  test('reuses existing worktree when plan.last_failed_phase === commit', async () => {
    // Single-unit plan that failed at the commit phase. The worktree dir
    // exists on disk and carries the implement+fix diff; setupPlanWorktrees
    // must NOT wipe it and recreate from dev_branch.
    const wtRoot = worktreeRootPath('worktree-path-rewrite');
    const plan = makePlan({
      last_failed_phase: 'commit',
      worktrees: [
        {
          repo: null,
          path: wtRoot,
          branch: 'lauren/worktree-path-rewrite',
          parentRoot: '/workspace/app',
        },
      ],
    });
    await fs.mkdir(wtRoot, { recursive: true });
    await fs.mkdir(path.dirname(planFilePath(plan)), { recursive: true });
    await fs.writeFile(planFilePath(plan), '# Updated plan\n', 'utf8');
    await fs.mkdir(path.join(wtRoot, '.lauren', 'plans'), { recursive: true });
    await fs.writeFile(
      path.join(wtRoot, '.lauren', 'plans', `${plan.slug}.md`),
      '# Stale plan\n',
      'utf8',
    );

    const ctx = await setupPlanWorktrees(plan, DEFAULT_CONFIG);

    expect(gitWorktreeRemove).not.toHaveBeenCalled();
    expect(gitWorktreeAdd).not.toHaveBeenCalled();
    expect(resolveWorkspaceRepos).not.toHaveBeenCalled();
    expect(ctx.rootCwd).toBe(wtRoot);
    expect(ctx.worktrees).toEqual(plan.worktrees);
    expect(ctx.rewrittenRepos).toEqual([{ name: '.', path: '.', root: wtRoot }]);
    expect(ctx.commitResumeStale).toBe(false);
    expect(ctx.reusedWorktrees).toBe(true);
    await expect(
      fs.readFile(path.join(wtRoot, '.lauren', 'plans', `${plan.slug}.md`), 'utf8'),
    ).resolves.toBe('# Updated plan\n');
  });

  test('reuses existing worktree when any step has failed_phase === commit', async () => {
    const wtRoot = worktreeRootPath('worktree-path-rewrite');
    const plan = makePlan({
      worktrees: [
        {
          repo: null,
          path: wtRoot,
          branch: 'lauren/worktree-path-rewrite',
          parentRoot: '/workspace/app',
        },
      ],
      steps: [
        {
          id: '1.1',
          title: 'done step',
          status: 'done',
          commit_subject: 'x',
          started_at: null,
          finished_at: null,
        },
        {
          id: '1.2',
          title: 'failed at commit',
          status: 'failed',
          failed_phase: 'commit',
          commit_subject: null,
          started_at: null,
          finished_at: null,
        },
      ],
    });
    await fs.mkdir(wtRoot, { recursive: true });
    await fs.mkdir(path.dirname(planFilePath(plan)), { recursive: true });
    await fs.writeFile(planFilePath(plan), '# Updated plan\n', 'utf8');

    const ctx = await setupPlanWorktrees(plan, DEFAULT_CONFIG);

    expect(gitWorktreeRemove).not.toHaveBeenCalled();
    expect(gitWorktreeAdd).not.toHaveBeenCalled();
    expect(ctx.rootCwd).toBe(wtRoot);
    expect(ctx.reusedWorktrees).toBe(true);
  });

  test('falls back to fresh setup AND flags commitResumeStale when the worktree is gone', async () => {
    const plan = makePlan({
      last_failed_phase: 'commit',
      worktrees: [
        {
          repo: null,
          path: worktreeRootPath('worktree-path-rewrite'),
          branch: 'lauren/worktree-path-rewrite',
          parentRoot: '/workspace/app',
        },
      ],
    });
    // No worktree dir on disk → reuse must fail and the normal path runs.
    const repos: ResolvedWorkspaceRepo[] = [{ name: 'app', path: '.', root: '/workspace/app' }];
    vi.mocked(resolveWorkspaceRepos).mockResolvedValue(repos);
    await fs.mkdir(path.dirname(planFilePath(plan)), { recursive: true });
    await fs.writeFile(planFilePath(plan), '# Plan body\n', 'utf8');

    const ctx = await setupPlanWorktrees(plan, DEFAULT_CONFIG);

    expect(gitWorktreeAdd).toHaveBeenCalledTimes(1);
    // Critical: caller must scrub failed_phase / last_failed_phase before
    // flipping to `implementing`, otherwise the executor's resume path
    // would silently mark the unit done on the new clean tree.
    expect(ctx.commitResumeStale).toBe(true);
    expect(ctx.reusedWorktrees).toBe(false);
  });

  test('reports commitResumeStale=false on a normal (non-resume) setup', async () => {
    const plan = makePlan();
    const repos: ResolvedWorkspaceRepo[] = [{ name: 'app', path: '.', root: '/workspace/app' }];
    vi.mocked(resolveWorkspaceRepos).mockResolvedValue(repos);
    await fs.mkdir(path.dirname(planFilePath(plan)), { recursive: true });
    await fs.writeFile(planFilePath(plan), '# Plan body\n', 'utf8');

    const ctx = await setupPlanWorktrees(plan, DEFAULT_CONFIG);

    expect(ctx.commitResumeStale).toBe(false);
    expect(ctx.reusedWorktrees).toBe(false);
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

describe('cleanupPlanWorktrees', () => {
  test('refuses to remove any worktree when requireClean finds a dirty one', async () => {
    const plan = makePlan({
      worktrees: [
        {
          repo: null,
          path: worktreeRootPath('worktree-path-rewrite'),
          branch: 'lauren/worktree-path-rewrite',
          parentRoot: '/workspace/app',
        },
      ],
    });
    await fs.mkdir(worktreeRootPath(plan.slug), { recursive: true });
    vi.mocked(workingTreeDirty).mockReturnValue(true);

    await expect(
      cleanupPlanWorktrees(plan, { keepBranches: true, requireClean: true }),
    ).rejects.toThrow('worktree(s) must be clean before removal');

    expect(gitWorktreeRemove).not.toHaveBeenCalled();
    expect(gitDeleteBranch).not.toHaveBeenCalled();
  });

  test('removes clean worktrees when requireClean passes', async () => {
    const plan = makePlan({
      worktrees: [
        {
          repo: null,
          path: worktreeRootPath('worktree-path-rewrite'),
          branch: 'lauren/worktree-path-rewrite',
          parentRoot: '/workspace/app',
        },
      ],
    });
    await fs.mkdir(worktreeRootPath(plan.slug), { recursive: true });
    vi.mocked(workingTreeDirty).mockReturnValue(false);

    await cleanupPlanWorktrees(plan, { keepBranches: true, requireClean: true });

    expect(workingTreeDirty).toHaveBeenCalledWith(worktreeRootPath(plan.slug));
    expect(gitWorktreeRemove).toHaveBeenCalledWith({
      repoRoot: '/workspace/app',
      worktreePath: worktreeRootPath(plan.slug),
    });
    expect(gitDeleteBranch).not.toHaveBeenCalled();
  });
});
