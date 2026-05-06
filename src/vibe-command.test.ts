import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { TodoStore } from './core/store.js';
import type { Plan } from './core/types.js';
import { resolveWorkspaceRepos } from './core/workspace.js';
import { revertWorkingTree } from './proc/git.js';
import { finalizeCancelledImplementingPlans } from './vibe-command.js';

vi.mock('./core/workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./core/workspace.js')>();
  return {
    ...actual,
    resolveWorkspaceRepos: vi.fn(),
  };
});

vi.mock('./proc/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./proc/git.js')>();
  return {
    ...actual,
    revertWorkingTree: vi.fn(),
  };
});

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    slug: 'demo-plan',
    title: 'Demo plan',
    path: '.lauren/plans/demo-plan.md',
    target_repos: [],
    status: 'implementing',
    cancel_requested: true,
    created_at: '2026-05-08T12:00:00Z',
    started_at: '2026-05-08T12:05:00Z',
    finished_at: null,
    failure: null,
    ...overrides,
  };
}

function makeStore(): TodoStore {
  return {
    update: vi.fn(async () => makePlan({ status: 'cancelled' })),
  } as unknown as TodoStore;
}

describe('finalizeCancelledImplementingPlans', () => {
  const frontend = { name: 'frontend', path: 'apps/frontend', root: '/workspace/apps/frontend' };
  const backend = { name: 'backend', path: 'backend', root: '/workspace/backend' };

  beforeEach(() => {
    vi.mocked(resolveWorkspaceRepos).mockReset();
    vi.mocked(revertWorkingTree).mockReset();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('reverts only the cancelled plans target repos', async () => {
    vi.mocked(resolveWorkspaceRepos).mockImplementation(async (targets = []) => {
      if (targets.length === 0) return [frontend, backend];
      return targets.includes('frontend') ? [frontend] : [];
    });

    await expect(
      finalizeCancelledImplementingPlans(makeStore(), [makePlan({ target_repos: ['frontend'] })]),
    ).resolves.toBe(true);

    expect(resolveWorkspaceRepos).toHaveBeenCalledWith(['frontend']);
    expect(revertWorkingTree).toHaveBeenCalledTimes(1);
    expect(revertWorkingTree).toHaveBeenCalledWith(frontend.root);
  });

  test('keeps untargeted cancellation semantics as all workspace repos', async () => {
    vi.mocked(resolveWorkspaceRepos).mockResolvedValue([frontend, backend]);

    await expect(
      finalizeCancelledImplementingPlans(makeStore(), [makePlan({ target_repos: [] })]),
    ).resolves.toBe(true);

    expect(resolveWorkspaceRepos).toHaveBeenCalledWith([]);
    expect(revertWorkingTree).toHaveBeenCalledWith(frontend.root);
    expect(revertWorkingTree).toHaveBeenCalledWith(backend.root);
  });
});
