import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_CONFIG, type LaurenConfig } from './core/config.js';
import type { PlanStore } from './core/store.js';
import type { Plan } from './core/types.js';
import { resolveWorkspaceRepos } from './core/workspace.js';
import { runPlan } from './executor.js';
import { finalizeMerge, mergePlanOnce } from './merger.js';
import { processEnqueuedPlan } from './organize.js';
import { workingTreeDirty } from './proc/git.js';
import { WatcherRuntime } from './tui/runtime.js';
import {
  handleCancelSignal,
  IDLE_POLL_SECONDS,
  type WatcherLoopHandles,
  watcherLoop,
} from './watcher.js';
import { cleanupPlanWorktrees, setupPlanWorktrees } from './worktree.js';

const TEST_CONFIG: LaurenConfig = { ...DEFAULT_CONFIG };

vi.mock('./executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./executor.js')>();
  return {
    ...actual,
    runPlan: vi.fn(),
  };
});

vi.mock('./organize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./organize.js')>();
  return {
    ...actual,
    processEnqueuedPlan: vi.fn(),
  };
});

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
    workingTreeDirty: vi.fn(),
  };
});

vi.mock('./merger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./merger.js')>();
  return {
    ...actual,
    mergePlanOnce: vi.fn(),
    finalizeMerge: vi.fn(),
  };
});

vi.mock('./worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worktree.js')>();
  return {
    ...actual,
    setupPlanWorktrees: vi.fn(async (plan: Plan) => ({
      rootCwd: `/tmp/worktree/${plan.slug}`,
      rewrittenRepos: [],
      worktrees: [],
    })),
    cleanupPlanWorktrees: vi.fn(async () => undefined),
  };
});

afterEach(() => {
  vi.mocked(runPlan).mockReset();
  vi.mocked(processEnqueuedPlan).mockReset();
  vi.mocked(resolveWorkspaceRepos).mockReset();
  vi.mocked(workingTreeDirty).mockReset();
  vi.mocked(setupPlanWorktrees).mockReset();
  vi.mocked(cleanupPlanWorktrees).mockReset();
  vi.mocked(mergePlanOnce).mockReset();
  vi.mocked(finalizeMerge).mockReset();
  vi.mocked(setupPlanWorktrees).mockImplementation(async (plan: Plan) => ({
    rootCwd: `/tmp/worktree/${plan.slug}`,
    rewrittenRepos: [],
    worktrees: [],
  }));
  vi.mocked(cleanupPlanWorktrees).mockResolvedValue(undefined);
  vi.mocked(mergePlanOnce).mockResolvedValue({ kind: 'done' });
  vi.mocked(finalizeMerge).mockResolvedValue(undefined);
});

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    slug: 'demo',
    title: 'Demo',
    path: '.lauren/plans/demo.md',
    target_repos: [],
    status: 'implementing',
    cancel_requested: true,
    created_at: '2026-05-08T12:00:00Z',
    started_at: '2026-05-08T12:05:00Z',
    finished_at: null,
    failure: null,
    steps: null,
    ...overrides,
  };
}

function makeHandles(overrides: Partial<WatcherLoopHandles> = {}): WatcherLoopHandles {
  return {
    current: { slug: null },
    phase: { value: 'idle' },
    cancelController: { ref: null },
    brainState: { current: null, controller: null },
    ...overrides,
  };
}

describe('handleCancelSignal', () => {
  test('aborts the implementing controller when the in-flight plan was cancelled', async () => {
    const abort = vi.fn();
    const handles = makeHandles({
      current: { slug: 'demo' },
      phase: { value: 'implementing' },
      cancelController: { ref: { abort } as unknown as AbortController },
    });
    const store = { find: vi.fn(async () => makePlan()) };

    await handleCancelSignal(store, handles);

    expect(abort).toHaveBeenCalledTimes(1);
  });

  test('aborts the brain controller when the in-flight plan was cancelled mid-organize', async () => {
    const abort = vi.fn();
    const handles = makeHandles({
      current: { slug: 'demo' },
      phase: { value: 'organizing' },
      brainState: { current: 'demo', controller: { abort } as unknown as AbortController },
    });
    const store = { find: vi.fn(async () => makePlan({ status: 'preparing' })) };

    await handleCancelSignal(store, handles);

    expect(abort).toHaveBeenCalledTimes(1);
  });

  test('is a no-op when no plan is in flight', async () => {
    const handles = makeHandles({ current: { slug: null } });
    const store = { find: vi.fn(async () => null) };

    await handleCancelSignal(store, handles);

    expect(store.find).not.toHaveBeenCalled();
  });

  test('is a no-op when the cancelled row no longer has cancel_requested set', async () => {
    const abort = vi.fn();
    const handles = makeHandles({
      current: { slug: 'demo' },
      phase: { value: 'implementing' },
      cancelController: { ref: { abort } as unknown as AbortController },
    });
    const store = { find: vi.fn(async () => makePlan({ cancel_requested: false })) };

    await handleCancelSignal(store, handles);

    expect(abort).not.toHaveBeenCalled();
  });

  test('does not abort when the in-flight slug changed during the store read', async () => {
    // Setup: when SIGUSR2 fires, the daemon is organizing 'demo'. The store
    // read takes long enough that, by the time it returns, the daemon has
    // transitioned to implementing a *different* plan. Dispatching on the
    // current phase/controller now would abort an unrelated subprocess.
    const abort = vi.fn();
    const handles = makeHandles({
      current: { slug: 'demo' },
      phase: { value: 'organizing' },
      brainState: { current: 'demo', controller: { abort } as unknown as AbortController },
    });
    const store = {
      find: vi.fn(async () => {
        // Simulate the phase-shift that happens while we wait for disk I/O.
        handles.current.slug = 'unrelated-plan';
        handles.phase.value = 'implementing';
        handles.cancelController.ref = { abort: vi.fn() } as unknown as AbortController;
        return makePlan();
      }),
    };

    await handleCancelSignal(store, handles);

    expect(abort).not.toHaveBeenCalled();
    expect(handles.cancelController.ref?.abort).not.toHaveBeenCalled();
  });
});

describe('watcherLoop pause-on-cancelling', () => {
  test("pauses (does not claim ready) when a 'cancelling' row exists", async () => {
    const cancellingPlan = makePlan({
      slug: 'stuck',
      status: 'cancelling',
      cancel_requested: false,
      cancel_intent: undefined,
    });
    const readyPlan = makePlan({
      slug: 'next',
      status: 'ready',
      cancel_requested: false,
    });

    const runtime = new WatcherRuntime();
    const setPausedCancelling = vi.spyOn(runtime, 'setPausedCancelling');
    // Track that the ready plan never gets claimed (status flipped to implementing).
    const updateSpy = vi.fn();

    const controller = new AbortController();
    // Fire the abort once pause is triggered so the loop exits cleanly.
    setPausedCancelling.mockImplementation(() => {
      controller.abort();
    });

    const store = {
      read: vi.fn(async () => [cancellingPlan, readyPlan]),
      update: updateSpy,
    } as unknown as PlanStore;

    const handles = makeHandles();
    const result = await watcherLoop(runtime, store, TEST_CONFIG, controller.signal, handles);

    expect(setPausedCancelling).toHaveBeenCalledWith([cancellingPlan, readyPlan], cancellingPlan);
    // No mutation of the ready row (would happen if the loop tried to claim).
    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.inFlight).toBeNull();
    expect(result.cancelledSlug).toBeNull();
  });

  test("pauses before draining enqueued plans when a 'cancelling' row exists", async () => {
    const cancellingPlan = makePlan({
      slug: 'stuck',
      status: 'cancelling',
      cancel_requested: false,
      cancel_intent: undefined,
    });
    const enqueuedPlan = makePlan({
      slug: 'new-work',
      status: 'enqueued',
      cancel_requested: false,
      started_at: null,
    });

    const runtime = new WatcherRuntime();
    const setPausedCancelling = vi.spyOn(runtime, 'setPausedCancelling');
    const controller = new AbortController();
    setPausedCancelling.mockImplementation(() => {
      controller.abort();
    });
    vi.mocked(processEnqueuedPlan).mockImplementation(async () => {
      controller.abort();
    });

    const store = {
      read: vi.fn(async () => [cancellingPlan, enqueuedPlan]),
      update: vi.fn(),
    } as unknown as PlanStore;

    const result = await watcherLoop(runtime, store, TEST_CONFIG, controller.signal, makeHandles());

    expect(setPausedCancelling).toHaveBeenCalledWith(
      [cancellingPlan, enqueuedPlan],
      cancellingPlan,
    );
    expect(processEnqueuedPlan).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
    expect(result.inFlight).toBeNull();
    expect(result.cancelledSlug).toBeNull();
  });

  test("rechecks the workspace after a 'cancelling' row clears before draining queued work", async () => {
    vi.useFakeTimers();

    try {
      const repo = { name: 'app', path: '.', root: '/workspace/app' };
      vi.mocked(resolveWorkspaceRepos).mockResolvedValue([repo]);
      vi.mocked(workingTreeDirty).mockReturnValue(true);

      const cancellingPlan = makePlan({
        slug: 'stuck',
        status: 'cancelling',
        cancel_requested: false,
        cancel_intent: undefined,
      });
      const cancelledPlan = makePlan({
        slug: 'stuck',
        status: 'cancelled',
        cancel_requested: false,
        cancel_intent: undefined,
        finished_at: '2026-05-08T12:10:00Z',
      });
      const enqueuedPlan = makePlan({
        slug: 'new-work',
        status: 'enqueued',
        cancel_requested: false,
        started_at: null,
      });

      const runtime = new WatcherRuntime();
      const setPausedCancelling = vi.spyOn(runtime, 'setPausedCancelling');
      const setPausedDirtyWorkspace = vi.spyOn(runtime, 'setPausedDirtyWorkspace');
      const controller = new AbortController();
      setPausedDirtyWorkspace.mockImplementation(() => {
        controller.abort();
      });

      let cancellingActive = true;
      setPausedCancelling.mockImplementation(() => {
        cancellingActive = false;
      });
      const store = {
        read: vi.fn(async () =>
          cancellingActive ? [cancellingPlan, enqueuedPlan] : [cancelledPlan, enqueuedPlan],
        ),
        update: vi.fn(),
      } as unknown as PlanStore;

      const resultPromise = watcherLoop(
        runtime,
        store,
        TEST_CONFIG,
        controller.signal,
        makeHandles(),
      );

      await vi.waitFor(() => {
        expect(setPausedCancelling).toHaveBeenCalledWith(
          [cancellingPlan, enqueuedPlan],
          cancellingPlan,
        );
      });
      await vi.advanceTimersByTimeAsync(IDLE_POLL_SECONDS * 1000);
      const result = await resultPromise;

      expect(resolveWorkspaceRepos).toHaveBeenCalledWith();
      expect(workingTreeDirty).toHaveBeenCalledWith(repo.root);
      expect(setPausedDirtyWorkspace).toHaveBeenCalledWith(
        [cancelledPlan, enqueuedPlan],
        'app (.)',
      );
      expect(processEnqueuedPlan).not.toHaveBeenCalled();
      expect(store.update).not.toHaveBeenCalled();
      expect(result.inFlight).toBeNull();
      expect(result.cancelledSlug).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('watcherLoop implementing cancellation', () => {
  test("uses the fresh cancel_intent when an in-flight plan is cancelled with intent='keep'", async () => {
    const slug = `watcher-keep-cancel-${Date.now()}`;
    const path = `.lauren/plans/${slug}.md`;
    await fs.mkdir('.lauren/plans', { recursive: true });
    await fs.writeFile(path, '# Demo\n', 'utf8');

    try {
      let plan = makePlan({
        slug,
        path,
        status: 'ready',
        cancel_requested: false,
        cancel_intent: undefined,
        started_at: null,
      });

      const runtime = new WatcherRuntime();
      const controller = new AbortController();
      const handles = makeHandles();
      const setPausedCancelling = vi.spyOn(runtime, 'setPausedCancelling');
      setPausedCancelling.mockImplementation(() => {
        controller.abort();
      });

      const store = {
        read: vi.fn(async () => [plan]),
        find: vi.fn(async (targetSlug: string) => (targetSlug === plan.slug ? plan : null)),
        update: vi.fn(async (_slug: string, fields: Partial<Plan>) => {
          plan = { ...plan, ...fields };
          return { ...plan };
        }),
      } as unknown as PlanStore;

      vi.mocked(runPlan).mockImplementation(async () => {
        plan = { ...plan, cancel_requested: true, cancel_intent: 'keep' };
        handles.cancelController.ref?.abort();
        throw new Error('aborted');
      });

      const result = await watcherLoop(runtime, store, TEST_CONFIG, controller.signal, handles);

      expect(result.inFlight).toBeNull();
      expect(result.cancelledSlug).toBeNull();
      expect(store.find).toHaveBeenCalledWith(slug);
      expect(plan.status).toBe('cancelling');
      expect(plan.cancel_requested).toBe(false);
      expect(plan.cancel_intent).toBeUndefined();
      expect(setPausedCancelling).toHaveBeenCalledWith([plan], plan);
    } finally {
      await fs.unlink(path).catch(() => undefined);
    }
  });
});

describe('watcherLoop merging cancellation', () => {
  test('honors a persisted merge cancel request before polling or merging', async () => {
    const mergingPlan = makePlan({
      status: 'merging',
      cancel_requested: true,
      worktrees: [{ repo: null, path: '/wt/root', branch: 'lauren/demo', parentRoot: '/repo' }],
    });
    const runtime = new WatcherRuntime();
    const controller = new AbortController();
    vi.mocked(finalizeMerge).mockImplementation(async () => {
      controller.abort();
    });

    const store = {
      read: vi.fn(async () => [mergingPlan]),
      update: vi.fn(),
    } as unknown as PlanStore;

    await watcherLoop(runtime, store, TEST_CONFIG, controller.signal, makeHandles());

    expect(cleanupPlanWorktrees).toHaveBeenCalledWith(mergingPlan);
    expect(finalizeMerge).toHaveBeenCalledWith(store, 'demo', { kind: 'cancelled' });
    expect(mergePlanOnce).not.toHaveBeenCalled();
  });

  test('keeps merge cancellation active while waiting between PR polls', async () => {
    vi.useFakeTimers();

    try {
      let mergingPlan = makePlan({
        status: 'merging',
        cancel_requested: false,
        worktrees: [{ repo: null, path: '/wt/root', branch: 'lauren/demo', parentRoot: '/repo' }],
      });
      const controller = new AbortController();
      const handles = makeHandles();
      vi.mocked(mergePlanOnce).mockResolvedValue({ kind: 'pending' });
      vi.mocked(finalizeMerge).mockImplementation(async () => {
        controller.abort();
      });

      const store = {
        read: vi.fn(async () => [mergingPlan]),
        find: vi.fn(async () => mergingPlan),
        update: vi.fn(),
      } as unknown as PlanStore;

      const loop = watcherLoop(
        new WatcherRuntime(),
        store,
        TEST_CONFIG,
        controller.signal,
        handles,
      );
      await vi.waitFor(() => {
        expect(mergePlanOnce).toHaveBeenCalledWith(
          expect.objectContaining({ plan: mergingPlan, signal: expect.any(AbortSignal) }),
        );
        expect(handles.current.slug).toBe('demo');
        expect(handles.phase.value).toBe('merging');
        expect(handles.cancelController.ref).not.toBeNull();
      });

      mergingPlan = { ...mergingPlan, cancel_requested: true };
      await handleCancelSignal(store, handles);

      await vi.waitFor(() => {
        expect(cleanupPlanWorktrees).toHaveBeenCalledWith(
          expect.objectContaining({ slug: 'demo' }),
        );
        expect(finalizeMerge).toHaveBeenCalledWith(store, 'demo', { kind: 'cancelled' });
      });
      await loop;

      expect(handles.current.slug).toBeNull();
      expect(handles.cancelController.ref).toBeNull();
      expect(handles.phase.value).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  test('finalizes done when a user cancel arrives after merge completion', async () => {
    const mergingPlan = makePlan({
      status: 'merging',
      cancel_requested: false,
      worktrees: [{ repo: null, path: '/wt/root', branch: 'lauren/demo', parentRoot: '/repo' }],
    });
    const controller = new AbortController();
    const handles = makeHandles();
    vi.mocked(mergePlanOnce).mockImplementation(async () => {
      handles.cancelController.ref?.abort();
      return { kind: 'done' };
    });
    vi.mocked(finalizeMerge).mockImplementation(async () => {
      controller.abort();
    });

    const store = {
      read: vi.fn(async () => [mergingPlan]),
      update: vi.fn(),
    } as unknown as PlanStore;

    await watcherLoop(new WatcherRuntime(), store, TEST_CONFIG, controller.signal, handles);

    expect(finalizeMerge).toHaveBeenCalledWith(store, 'demo', { kind: 'done' });
    expect(cleanupPlanWorktrees).not.toHaveBeenCalled();
    expect(handles.current.slug).toBeNull();
    expect(handles.cancelController.ref).toBeNull();
    expect(handles.phase.value).toBe('idle');
  });

  test('does not finalize cancelled when only the daemon shutdown signal aborted the merge', async () => {
    const mergingPlan = makePlan({
      status: 'merging',
      cancel_requested: false,
      worktrees: [{ repo: null, path: '/wt/root', branch: 'lauren/demo', parentRoot: '/repo' }],
    });
    const controller = new AbortController();
    vi.mocked(mergePlanOnce).mockImplementation(async () => {
      controller.abort();
      return { kind: 'cancelled' };
    });

    const store = {
      read: vi.fn(async () => [mergingPlan]),
      update: vi.fn(),
    } as unknown as PlanStore;

    const handles = makeHandles();
    await watcherLoop(new WatcherRuntime(), store, TEST_CONFIG, controller.signal, handles);

    expect(finalizeMerge).not.toHaveBeenCalled();
    expect(cleanupPlanWorktrees).not.toHaveBeenCalled();
    expect(handles.current.slug).toBeNull();
    expect(handles.cancelController.ref).toBeNull();
    expect(handles.phase.value).toBe('idle');
  });
});
