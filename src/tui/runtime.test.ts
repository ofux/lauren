import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Plan } from '../core/types.js';
import { WatcherRuntime } from './runtime.js';

function planWithFailure(message: string): Plan {
  return {
    slug: 'feat-x',
    title: 'Feature X',
    path: '.lauren/plans/feat-x.md',
    target_repos: [],
    status: 'failed',
    cancel_requested: false,
    created_at: '2026-05-08T12:00:00Z',
    started_at: null,
    finished_at: null,
    failure: {
      step: 'commit',
      pr_id: null,
      message,
    },
  };
}

describe('WatcherRuntime.setPaused', () => {
  const originalNoSound = process.env.LAUREN_NO_SOUND;

  beforeEach(() => {
    process.env.LAUREN_NO_SOUND = '1';
  });

  afterEach(() => {
    if (originalNoSound === undefined) {
      delete process.env.LAUREN_NO_SOUND;
    } else {
      process.env.LAUREN_NO_SOUND = originalNoSound;
    }
  });

  test('keeps the generic retry hint for commit-step failures without their own recovery instructions', () => {
    const runtime = new WatcherRuntime();
    const failed = planWithFailure('no target repo has changes to commit');

    runtime.setPaused([failed], failed);

    expect(runtime.idleMessage).toContain("Press `t` on 'feat-x' in `lauren` to reset it to ready");
    expect(runtime.idleMessage).toContain('or cancel it from there');
  });

  test('does not duplicate the generic hint when a git commit failure already explains recovery', () => {
    const runtime = new WatcherRuntime();
    const failed = planWithFailure(
      [
        "failed to commit changes in repo 'backend' (apps/backend). git exited 1",
        'Pausing vibe until you fix it. Inspect the staged changes, address the error,',
        'then commit manually with this subject (so resume detects it):',
        '  feat-x: PR 1.2 - Add foo',
        "Then press `t` on 'feat-x' in `lauren` to reset it to ready, or restart `lauren vibe`.",
      ].join('\n'),
    );

    runtime.setPaused([failed], failed);

    expect(runtime.idleMessage).not.toContain('or cancel it from there');
    expect(runtime.idleMessage.match(/press `t` on 'feat-x' in `lauren`/g)).toHaveLength(1);
  });
});

describe('WatcherRuntime.setPausedCancelling', () => {
  const originalNoSound = process.env.LAUREN_NO_SOUND;

  beforeEach(() => {
    process.env.LAUREN_NO_SOUND = '1';
  });

  afterEach(() => {
    if (originalNoSound === undefined) {
      delete process.env.LAUREN_NO_SOUND;
    } else {
      process.env.LAUREN_NO_SOUND = originalNoSound;
    }
  });

  function cancellingPlan(): Plan {
    return {
      slug: 'feat-y',
      title: 'Feature Y',
      path: '.lauren/plans/feat-y.md',
      target_repos: [],
      status: 'cancelling',
      cancel_requested: false,
      created_at: '2026-05-08T12:00:00Z',
      started_at: null,
      finished_at: null,
      failure: null,
    } as Plan;
  }

  test("explains how to resume from 'cancelling' and tells the user to flip status", () => {
    const runtime = new WatcherRuntime();
    const plan = cancellingPlan();

    runtime.setPausedCancelling([plan], plan);

    expect(runtime.idleState).toBe('paused');
    expect(runtime.idleMessage).toContain("plan 'feat-y' is cancelling");
    expect(runtime.idleMessage).toContain("status to 'cancelled'");
    expect(runtime.idleMessage).toContain('git status');
  });
});
