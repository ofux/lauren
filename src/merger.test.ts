import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_CONFIG, type LaurenConfig } from './core/config.js';
import type { PlanStore } from './core/store.js';
import type { Plan, PlanWorktree } from './core/types.js';
import { finalizeMerge, mergePlanOnce } from './merger.js';
import { ghPrCreate, ghPrView } from './proc/gh.js';
import {
  getCurrentBranch,
  gitAddAll,
  gitBranchHasDiff,
  gitDeleteBranch,
  gitFastForward,
  gitFetchBranch,
  gitMerge,
  gitMergeAbort,
  gitMergeContinue,
  gitPush,
  gitWorktreeRemove,
  hasUnresolvedMergeConflicts,
} from './proc/git.js';
import { streamSubprocess } from './proc/stream.js';

vi.mock('./proc/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./proc/git.js')>();
  return {
    ...actual,
    getCurrentBranch: vi.fn(),
    gitBranchHasDiff: vi.fn(),
    gitMerge: vi.fn(),
    gitDeleteBranch: vi.fn(),
    gitWorktreeRemove: vi.fn(),
    gitFetchBranch: vi.fn(),
    gitFastForward: vi.fn(),
    gitPush: vi.fn(),
    gitCheckout: vi.fn(),
    workingTreeDirty: vi.fn(() => false),
    gitAddAll: vi.fn(),
    gitMergeAbort: vi.fn(() => ({ code: 0, stdout: '', stderr: '' })),
    gitMergeContinue: vi.fn(() => ({ code: 0, stdout: '', stderr: '' })),
    hasUnresolvedMergeConflicts: vi.fn(() => false),
  };
});

vi.mock('./proc/gh.js', () => ({
  GhError: class GhError extends Error {
    code: number;
    stderr: string;
    constructor(message: string, code: number, stderr: string) {
      super(message);
      this.name = 'GhError';
      this.code = code;
      this.stderr = stderr;
    }
  },
  ghPrCreate: vi.fn(),
  ghPrView: vi.fn(),
}));

vi.mock('./proc/stream.js', () => ({
  streamSubprocess: vi.fn(async () => 0),
}));

function worktree(repo: string | null, parentRoot: string): PlanWorktree {
  return {
    repo,
    path: `/wt/${repo ?? 'root'}`,
    branch: 'lauren/demo',
    parentRoot,
  };
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    slug: 'demo',
    title: 'Demo',
    path: '.lauren/plans/demo.md',
    target_repos: [],
    status: 'merging',
    cancel_requested: false,
    created_at: '2026-05-08T12:00:00Z',
    started_at: '2026-05-08T12:05:00Z',
    finished_at: null,
    failure: null,
    steps: null,
    worktrees: [worktree(null, '/repo')],
    ...overrides,
  };
}

function makeStore(): PlanStore {
  return {
    update: vi.fn(async (_slug: string, fields: Partial<Plan>) => ({
      ...makePlan(),
      ...fields,
    })),
  } as unknown as PlanStore;
}

const TEST_CONFIG: LaurenConfig = { ...DEFAULT_CONFIG };

describe('mergePlanOnce — auto mode', () => {
  beforeEach(() => {
    vi.mocked(getCurrentBranch).mockReturnValue('main');
    vi.mocked(gitMerge).mockReturnValue({
      code: 0,
      stdout: 'Merge made',
      stderr: '',
      hasConflicts: false,
    });
    vi.mocked(gitMergeContinue).mockReturnValue({ code: 0, stdout: '', stderr: '' });
    vi.mocked(hasUnresolvedMergeConflicts).mockReturnValue(false);
    vi.mocked(streamSubprocess).mockResolvedValue(0);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('clean merge tears down worktree, deletes branch, returns done', async () => {
    const plan = makePlan();
    const result = await mergePlanOnce({ plan, store: makeStore(), config: TEST_CONFIG });

    expect(result.kind).toBe('done');
    expect(gitMerge).toHaveBeenCalledWith('lauren/demo', '/repo');
    expect(gitWorktreeRemove).toHaveBeenCalledWith({
      repoRoot: '/repo',
      worktreePath: '/wt/root',
    });
    expect(gitDeleteBranch).toHaveBeenCalledWith('lauren/demo', '/repo');
  });

  test('non-conflict merge failure returns failed without cleanup', async () => {
    vi.mocked(gitMerge).mockReturnValue({
      code: 1,
      stdout: '',
      stderr: 'fatal: refusing to merge unrelated histories',
      hasConflicts: false,
    });
    const result = await mergePlanOnce({
      plan: makePlan(),
      store: makeStore(),
      config: TEST_CONFIG,
    });

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failure.phase).toBe('merge');
      expect(result.failure.message).toContain('git merge');
    }
    expect(gitWorktreeRemove).not.toHaveBeenCalled();
  });

  test('returns failed when no worktrees recorded', async () => {
    const result = await mergePlanOnce({
      plan: makePlan({ worktrees: [] }),
      store: makeStore(),
      config: TEST_CONFIG,
    });
    expect(result.kind).toBe('failed');
  });

  test('commits staged conflict resolutions after claude resolves conflicts', async () => {
    vi.mocked(gitMerge).mockReturnValue({
      code: 1,
      stdout: 'Auto-merging app.ts',
      stderr: 'Automatic merge failed; fix conflicts and then commit the result.',
      hasConflicts: true,
    });
    vi.mocked(hasUnresolvedMergeConflicts).mockReturnValue(false);

    const result = await mergePlanOnce({
      plan: makePlan(),
      store: makeStore(),
      config: TEST_CONFIG,
    });

    expect(result.kind).toBe('done');
    expect(gitAddAll).toHaveBeenCalledWith('/repo');
    expect(hasUnresolvedMergeConflicts).toHaveBeenCalledWith('/repo');
    expect(gitMergeContinue).toHaveBeenCalledWith('/repo');
    expect(gitMergeAbort).not.toHaveBeenCalled();
  });

  test('aborts when conflicts remain unresolved after claude runs', async () => {
    vi.mocked(gitMerge).mockReturnValue({
      code: 1,
      stdout: 'Auto-merging app.ts',
      stderr: 'Automatic merge failed; fix conflicts and then commit the result.',
      hasConflicts: true,
    });
    vi.mocked(hasUnresolvedMergeConflicts).mockReturnValue(true);

    const result = await mergePlanOnce({
      plan: makePlan(),
      store: makeStore(),
      config: TEST_CONFIG,
    });

    expect(result.kind).toBe('failed');
    expect(gitMergeAbort).toHaveBeenCalledWith('/repo');
    expect(gitMergeContinue).not.toHaveBeenCalled();
  });
});

describe('mergePlanOnce — github-pr mode', () => {
  const config: LaurenConfig = { ...DEFAULT_CONFIG, merge_mode: 'github-pr' };

  beforeEach(() => {
    vi.mocked(gitPush).mockReturnValue({ code: 0, stdout: '', stderr: '' });
    vi.mocked(gitBranchHasDiff).mockReturnValue(true);
    vi.mocked(getCurrentBranch).mockReturnValue('main');
    vi.mocked(gitFetchBranch).mockReturnValue({ code: 0, stdout: '', stderr: '' });
    vi.mocked(gitFastForward).mockReturnValue({ code: 0, stdout: '', stderr: '' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('opens a PR when no URL recorded, then returns pending', async () => {
    vi.mocked(ghPrCreate).mockReturnValue('https://github.com/x/y/pull/1');
    vi.mocked(ghPrView).mockReturnValue({ state: 'OPEN', merged: false });
    const store = makeStore();

    const result = await mergePlanOnce({ plan: makePlan(), store, config });

    expect(ghPrCreate).toHaveBeenCalledTimes(1);
    expect(store.update).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({ pr_urls: { '.': 'https://github.com/x/y/pull/1' } }),
      expect.objectContaining({ allowMerging: true }),
    );
    expect(result.kind).toBe('pending');
  });

  test('returns done when the PR is merged and cleans up', async () => {
    vi.mocked(ghPrView).mockReturnValue({ state: 'MERGED', merged: true });
    const plan = makePlan({ pr_urls: { '.': 'https://github.com/x/y/pull/1' } });

    const result = await mergePlanOnce({ plan, store: makeStore(), config });

    expect(result.kind).toBe('done');
    expect(ghPrCreate).not.toHaveBeenCalled();
    expect(gitFetchBranch).toHaveBeenCalledWith({ cwd: '/repo', branch: 'main' });
    expect(gitFastForward).toHaveBeenCalledWith('FETCH_HEAD', '/repo');
    expect(gitWorktreeRemove).toHaveBeenCalled();
    expect(gitDeleteBranch).toHaveBeenCalled();
  });

  test('returns failed without cleanup when merged PR cannot fast-forward locally', async () => {
    vi.mocked(ghPrView).mockReturnValue({ state: 'MERGED', merged: true });
    vi.mocked(gitFastForward).mockReturnValue({
      code: 1,
      stdout: '',
      stderr: 'fatal: Not possible to fast-forward',
    });
    const plan = makePlan({ pr_urls: { '.': 'https://github.com/x/y/pull/1' } });

    const result = await mergePlanOnce({ plan, store: makeStore(), config });

    expect(result.kind).toBe('failed');
    expect(gitWorktreeRemove).not.toHaveBeenCalled();
    expect(gitDeleteBranch).not.toHaveBeenCalled();
  });

  test('returns cancelled when the PR is closed without merging', async () => {
    vi.mocked(ghPrView).mockReturnValue({ state: 'CLOSED', merged: false });
    const plan = makePlan({ pr_urls: { '.': 'https://github.com/x/y/pull/1' } });

    const result = await mergePlanOnce({ plan, store: makeStore(), config });

    expect(result.kind).toBe('cancelled');
    expect(gitWorktreeRemove).toHaveBeenCalled();
  });

  test("doesn't recreate the PR when a URL is already on the row", async () => {
    vi.mocked(ghPrView).mockReturnValue({ state: 'OPEN', merged: false });
    const plan = makePlan({ pr_urls: { '.': 'https://github.com/x/y/pull/1' } });

    await mergePlanOnce({ plan, store: makeStore(), config });

    expect(ghPrCreate).not.toHaveBeenCalled();
  });

  test('treats a branch with no diff from the base as done without opening a PR', async () => {
    vi.mocked(gitBranchHasDiff).mockReturnValue(false);
    const store = makeStore();

    const result = await mergePlanOnce({ plan: makePlan(), store, config });

    expect(result.kind).toBe('done');
    expect(gitPush).not.toHaveBeenCalled();
    expect(ghPrCreate).not.toHaveBeenCalled();
    expect(ghPrView).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({ pr_urls: expect.anything() }),
      expect.anything(),
    );
    expect(gitWorktreeRemove).toHaveBeenCalled();
    expect(gitDeleteBranch).toHaveBeenCalled();
  });

  test('persists each PR URL immediately before continuing to later repos', async () => {
    const plan = makePlan({
      worktrees: [worktree('frontend', '/repo/frontend'), worktree('backend', '/repo/backend')],
    });
    const store = {
      update: vi.fn(async (_slug: string, fields: Partial<Plan>) => ({
        ...plan,
        ...fields,
      })),
    } as unknown as PlanStore;
    vi.mocked(ghPrCreate).mockReturnValue('https://github.com/x/y/pull/1');
    vi.mocked(gitPush)
      .mockReturnValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ code: 1, stdout: '', stderr: 'remote rejected' });

    const result = await mergePlanOnce({ plan, store, config });

    expect(result.kind).toBe('failed');
    expect(ghPrCreate).toHaveBeenCalledTimes(1);
    expect(store.update).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        pr_urls: { frontend: 'https://github.com/x/y/pull/1' },
      }),
      expect.objectContaining({ allowMerging: true }),
    );
  });
});

describe('finalizeMerge', () => {
  test("'done' clears pr_urls + worktrees and stamps finished_at", async () => {
    const store = makeStore();
    await finalizeMerge(store, 'demo', { kind: 'done' });
    expect(store.update).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        status: 'done',
        pr_urls: undefined,
        worktrees: undefined,
      }),
      expect.objectContaining({ allowMerging: true }),
    );
  });

  test("'cancelled' clears cancel flags and PR/worktree state", async () => {
    const store = makeStore();
    await finalizeMerge(store, 'demo', { kind: 'cancelled' });
    expect(store.update).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        status: 'cancelled',
        cancel_requested: false,
        cancel_intent: undefined,
      }),
      expect.objectContaining({ allowMerging: true }),
    );
  });
});
