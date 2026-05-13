import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_CONFIG, type LaurenConfig } from './core/config.js';
import type { PlanStore } from './core/store.js';
import type { Plan, PlanWorktree } from './core/types.js';
import { finalizeMerge, mergePlanOnce } from './merger.js';
import { ghPrCreate, ghPrView } from './proc/gh.js';
import {
  getCurrentBranch,
  gitAddAll,
  gitAddPaths,
  gitBranchHasDiff,
  gitCheckout,
  gitDeleteBranch,
  gitFastForward,
  gitFetchBranch,
  gitMerge,
  gitMergeAbort,
  gitMergeContinue,
  gitPush,
  gitWorktreeRemove,
  hasUnresolvedMergeConflicts,
  listUnresolvedConflicts,
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
    gitAddPaths: vi.fn(),
    gitMergeAbort: vi.fn(() => ({ code: 0, stdout: '', stderr: '' })),
    gitMergeContinue: vi.fn(() => ({ code: 0, stdout: '', stderr: '' })),
    hasUnresolvedMergeConflicts: vi.fn(() => false),
    listUnresolvedConflicts: vi.fn(() => []),
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

  test('returns cleanup_failed when cleanup fails after a clean merge', async () => {
    vi.mocked(gitWorktreeRemove).mockImplementationOnce(() => {
      throw new Error('locked');
    });

    const result = await mergePlanOnce({
      plan: makePlan(),
      store: makeStore(),
      config: TEST_CONFIG,
    });

    expect(result.kind).toBe('cleanup_failed');
    if (result.kind === 'cleanup_failed') {
      expect(result.failure.phase).toBe('cleanup');
      expect(result.failure.message).toContain('merge landed');
      expect(result.failure.message).toContain('locked');
    }
    expect(gitDeleteBranch).not.toHaveBeenCalled();
  });

  test('retries cleanup directly for a cleanup-pending merge', async () => {
    const result = await mergePlanOnce({
      plan: makePlan({
        failure: {
          phase: 'cleanup',
          step_id: null,
          message: 'merge landed, but cleanup failed: locked',
        },
      }),
      store: makeStore(),
      config: TEST_CONFIG,
    });

    expect(result.kind).toBe('done');
    expect(gitMerge).not.toHaveBeenCalled();
    expect(gitWorktreeRemove).toHaveBeenCalledWith({
      repoRoot: '/repo',
      worktreePath: '/wt/root',
    });
  });

  test('marks cleanup-pending PR cancellations cancelled after cleanup succeeds', async () => {
    const result = await mergePlanOnce({
      plan: makePlan({
        failure: {
          phase: 'cleanup',
          step_id: null,
          message: 'PR closed without merging, but cleanup failed: locked',
          cleanup_result: 'cancelled',
        },
      }),
      store: makeStore(),
      config: TEST_CONFIG,
    });

    expect(result.kind).toBe('cancelled');
    expect(gitMerge).not.toHaveBeenCalled();
    expect(gitWorktreeRemove).toHaveBeenCalledWith({
      repoRoot: '/repo',
      worktreePath: '/wt/root',
    });
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

  test('returns paused when git refuses the merge due to dirt overlap', async () => {
    vi.mocked(gitMerge).mockReturnValue({
      code: 1,
      stdout: '',
      stderr:
        'error: Your local changes to the following files would be overwritten by merge:\n' +
        '\tsrc/app.ts\n' +
        '\tsrc/lib/util.ts\n' +
        'Please commit your changes or stash them before you merge.\nAborting\n',
      hasConflicts: false,
    });
    const result = await mergePlanOnce({
      plan: makePlan({ worktrees: [worktree('frontend', '/workspace/apps/frontend')] }),
      store: makeStore(),
      config: TEST_CONFIG,
    });

    expect(result.kind).toBe('paused');
    if (result.kind === 'paused') {
      expect(result.block.reason).toBe('dirty-merge');
      expect(result.block.repo).toBe('frontend');
      expect(result.block.parent_root).toBe('/workspace/apps/frontend');
      expect(result.block.files).toEqual(['src/app.ts', 'src/lib/util.ts']);
      expect(result.block.message).toContain('src/app.ts');
    }
    expect(gitMerge).toHaveBeenCalledTimes(1);
    expect(gitWorktreeRemove).not.toHaveBeenCalled();
  });

  test('paused on the first repo whose merge git refuses; earlier repos already merged', async () => {
    vi.mocked(gitMerge).mockImplementation((_branch: string, cwd: string) => {
      if (cwd === '/workspace/backend') {
        return {
          code: 1,
          stdout: '',
          stderr:
            'error: Your local changes to the following files would be overwritten by merge:\n' +
            '\tbackend/main.go\nPlease commit your changes or stash them before you merge.\nAborting\n',
          hasConflicts: false,
        };
      }
      return { code: 0, stdout: 'Merge made', stderr: '', hasConflicts: false };
    });
    const result = await mergePlanOnce({
      plan: makePlan({
        worktrees: [
          worktree('frontend', '/workspace/apps/frontend'),
          worktree('backend', '/workspace/backend'),
        ],
      }),
      store: makeStore(),
      config: TEST_CONFIG,
    });

    expect(result.kind).toBe('paused');
    if (result.kind === 'paused') {
      expect(result.block.repo).toBe('backend');
      expect(result.block.parent_root).toBe('/workspace/backend');
      expect(result.block.files).toEqual(['backend/main.go']);
    }
    // Frontend merged before we hit the backend refusal; we don't roll it back.
    expect(gitMerge).toHaveBeenCalledWith('lauren/demo', '/workspace/apps/frontend');
    expect(gitMerge).toHaveBeenCalledWith('lauren/demo', '/workspace/backend');
  });

  test('unrelated dirt does NOT block: git allows the merge to proceed', async () => {
    // workingTreeDirty mock is irrelevant now — Option A relies on git
    // itself deciding. With gitMerge returning success (default mock), the
    // merge goes through even if the tree has unrelated WIP.
    const result = await mergePlanOnce({
      plan: makePlan({ worktrees: [worktree(null, '/repo')] }),
      store: makeStore(),
      config: TEST_CONFIG,
    });
    expect(result.kind).toBe('done');
    expect(gitMerge).toHaveBeenCalledWith('lauren/demo', '/repo');
  });

  test('returns failed when no worktrees recorded', async () => {
    const result = await mergePlanOnce({
      plan: makePlan({ worktrees: [] }),
      store: makeStore(),
      config: TEST_CONFIG,
    });
    expect(result.kind).toBe('failed');
  });

  test('returns aborted without treating a signal abort as plan cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await mergePlanOnce({
      plan: makePlan(),
      store: makeStore(),
      config: TEST_CONFIG,
      signal: controller.signal,
    });

    expect(result.kind).toBe('aborted');
    expect(gitMerge).not.toHaveBeenCalled();
    expect(gitWorktreeRemove).not.toHaveBeenCalled();
  });

  test('stages only the pre-claude conflict paths after resolution, not -A', async () => {
    vi.mocked(gitMerge).mockReturnValue({
      code: 1,
      stdout: 'Auto-merging app.ts',
      stderr: 'Automatic merge failed; fix conflicts and then commit the result.',
      hasConflicts: true,
    });
    vi.mocked(listUnresolvedConflicts).mockReturnValue(['src/app.ts', 'src/lib/util.ts']);
    vi.mocked(hasUnresolvedMergeConflicts).mockReturnValue(false);

    const result = await mergePlanOnce({
      plan: makePlan(),
      store: makeStore(),
      config: TEST_CONFIG,
    });

    expect(result.kind).toBe('done');
    // The conflict list is captured BEFORE claude (we don't want a
    // post-resolution `git diff` to return empty after claude added
    // resolved files, missing them in the staged set).
    expect(listUnresolvedConflicts).toHaveBeenCalledWith('/repo');
    // Crucially: gitAddAll must NOT be used here — unrelated WIP in the
    // parent checkout would otherwise be swept into the merge commit.
    expect(gitAddAll).not.toHaveBeenCalled();
    expect(gitAddPaths).toHaveBeenCalledWith('/repo', ['src/app.ts', 'src/lib/util.ts']);
    // Fallback staging runs before the safety check so resolved-but-unstaged
    // files do not still appear as U in the index.
    const addOrder = vi.mocked(gitAddPaths).mock.invocationCallOrder[0]!;
    const checkOrder = vi.mocked(hasUnresolvedMergeConflicts).mock.invocationCallOrder[0]!;
    expect(addOrder).toBeLessThan(checkOrder);
    expect(gitMergeContinue).toHaveBeenCalledWith('/repo');
    expect(gitMergeAbort).not.toHaveBeenCalled();
  });

  test('aborts an in-progress parent merge when the conflict resolver is interrupted', async () => {
    const controller = new AbortController();
    vi.mocked(gitMerge).mockReturnValue({
      code: 1,
      stdout: 'Auto-merging app.ts',
      stderr: 'Automatic merge failed; fix conflicts and then commit the result.',
      hasConflicts: true,
    });
    vi.mocked(streamSubprocess).mockImplementation(async () => {
      controller.abort();
      return 1;
    });

    const result = await mergePlanOnce({
      plan: makePlan(),
      store: makeStore(),
      config: TEST_CONFIG,
      signal: controller.signal,
    });

    expect(result.kind).toBe('aborted');
    expect(gitMergeAbort).toHaveBeenCalledWith('/repo');
    expect(gitWorktreeRemove).not.toHaveBeenCalled();
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

  test('returns cleanup_failed for a merged PR when cleanup fails', async () => {
    vi.mocked(ghPrView).mockReturnValue({ state: 'MERGED', merged: true });
    vi.mocked(gitWorktreeRemove).mockImplementationOnce(() => {
      throw new Error('locked');
    });
    const plan = makePlan({ pr_urls: { '.': 'https://github.com/x/y/pull/1' } });

    const result = await mergePlanOnce({ plan, store: makeStore(), config });

    expect(result.kind).toBe('cleanup_failed');
    if (result.kind === 'cleanup_failed') {
      expect(result.failure.phase).toBe('cleanup');
      expect(result.failure.message).toContain('locked');
    }
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

  test('pauses fast-forward when git refuses on dirt overlap in a later parent', async () => {
    vi.mocked(ghPrView).mockReturnValue({ state: 'MERGED', merged: true });
    vi.mocked(gitFastForward).mockImplementation((_ref: string, cwd?: string) => {
      if (cwd === '/repo/backend') {
        return {
          code: 1,
          stdout: '',
          stderr:
            'error: Your local changes to the following files would be overwritten by merge:\n' +
            '\tbackend/server.go\nPlease commit your changes or stash them before you merge.\nAborting\n',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const plan = makePlan({
      worktrees: [worktree('frontend', '/repo/frontend'), worktree('backend', '/repo/backend')],
      pr_urls: {
        frontend: 'https://github.com/x/y/pull/1',
        backend: 'https://github.com/x/y/pull/2',
      },
    });

    const result = await mergePlanOnce({ plan, store: makeStore(), config });

    expect(result.kind).toBe('paused');
    if (result.kind === 'paused') {
      expect(result.block.reason).toBe('dirty-fast-forward');
      expect(result.block.repo).toBe('backend');
      expect(result.block.parent_root).toBe('/repo/backend');
      expect(result.block.files).toEqual(['backend/server.go']);
    }
    // Frontend was fast-forwarded successfully before we hit the refusal.
    expect(gitFetchBranch).toHaveBeenCalledWith({ cwd: '/repo/frontend', branch: 'main' });
    expect(gitFetchBranch).toHaveBeenCalledWith({ cwd: '/repo/backend', branch: 'main' });
    expect(gitWorktreeRemove).not.toHaveBeenCalled();
  });

  test('pauses as remote-merged when checkout is dirty after PR merge', async () => {
    vi.mocked(ghPrView).mockReturnValue({ state: 'MERGED', merged: true });
    vi.mocked(getCurrentBranch).mockReturnValue('feature');
    const err = new Error('checkout refused') as Error & { gitStderr?: string };
    err.gitStderr =
      'error: Your local changes to the following files would be overwritten by checkout:\n' +
      '\tapp.ts\nPlease commit your changes or stash them before you switch branches.\nAborting\n';
    vi.mocked(gitCheckout).mockImplementationOnce(() => {
      throw err;
    });
    const plan = makePlan({ pr_urls: { '.': 'https://github.com/x/y/pull/1' } });

    const result = await mergePlanOnce({ plan, store: makeStore(), config });

    expect(result.kind).toBe('paused');
    if (result.kind === 'paused') {
      expect(result.block.reason).toBe('dirty-fast-forward');
      expect(result.block.repo).toBe(null);
      expect(result.block.parent_root).toBe('/repo');
      expect(result.block.files).toEqual(['app.ts']);
    }
    expect(gitFastForward).not.toHaveBeenCalled();
    expect(gitWorktreeRemove).not.toHaveBeenCalled();
  });

  test('returns cancelled when the PR is closed without merging', async () => {
    vi.mocked(ghPrView).mockReturnValue({ state: 'CLOSED', merged: false });
    const plan = makePlan({ pr_urls: { '.': 'https://github.com/x/y/pull/1' } });

    const result = await mergePlanOnce({ plan, store: makeStore(), config });

    expect(result.kind).toBe('cancelled');
    expect(gitWorktreeRemove).toHaveBeenCalled();
  });

  test('keeps PR-closed cleanup failures retryable', async () => {
    vi.mocked(ghPrView).mockReturnValue({ state: 'CLOSED', merged: false });
    vi.mocked(gitWorktreeRemove).mockImplementationOnce(() => {
      throw new Error('locked');
    });
    const plan = makePlan({ pr_urls: { '.': 'https://github.com/x/y/pull/1' } });

    const result = await mergePlanOnce({ plan, store: makeStore(), config });

    expect(result.kind).toBe('cleanup_failed');
    if (result.kind === 'cleanup_failed') {
      expect(result.failure.phase).toBe('cleanup');
      expect(result.failure.cleanup_result).toBe('cancelled');
      expect(result.failure.message).toContain('PR closed without merging');
      expect(result.failure.message).toContain('locked');
    }
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
        failure: null,
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
        failure: null,
        cancel_requested: false,
        cancel_intent: undefined,
      }),
      expect.objectContaining({ allowMerging: true }),
    );
  });
});
