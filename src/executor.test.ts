import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LOG_ROOT, PLANS_DIR } from './core/paths.js';
import type { StepEntry } from './core/steps.js';
import type { Plan } from './core/types.js';
import { formatCommitFailureMessage, type ProgressSink, RunFailure, runPlan } from './executor.js';
import { planCommitMessage } from './executor-prompts.js';
import { runCodexReview } from './proc/codex.js';
import { gitAddAll, gitCommit, workingTreeDirty } from './proc/git.js';
import { streamSubprocess } from './proc/stream.js';

vi.mock('./proc/stream.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./proc/stream.js')>();
  return { ...actual, streamSubprocess: vi.fn() };
});

vi.mock('./proc/codex.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./proc/codex.js')>();
  return { ...actual, runCodexReview: vi.fn() };
});

vi.mock('./proc/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./proc/git.js')>();
  return {
    ...actual,
    workingTreeDirty: vi.fn(),
    gitAddAll: vi.fn(),
    gitCommit: vi.fn(),
  };
});

describe('formatCommitFailureMessage', () => {
  const baseArgs = {
    repoName: 'backend',
    repoPath: 'apps/backend',
    commitSubject: 'feat-x: Step 1.2 — Add foo',
    slug: 'feat-x',
    exitCode: 1,
    gitTail: 'pre-commit hook failed',
  };

  test('names the repo, quotes the commit subject, and references the slug for retry', () => {
    const msg = formatCommitFailureMessage(baseArgs);
    expect(msg).toContain("repo 'backend' (apps/backend)");
    expect(msg).toContain('feat-x: Step 1.2 — Add foo');
    expect(msg).toContain("press `t` on 'feat-x' in `lauren`");
  });

  test('includes the git tail when present', () => {
    const msg = formatCommitFailureMessage(baseArgs);
    expect(msg).toContain('git exited 1: pre-commit hook failed');
  });

  test('omits the tail suffix when gitTail is empty (e.g. inherited stdio)', () => {
    const msg = formatCommitFailureMessage({ ...baseArgs, gitTail: '' });
    expect(msg).toContain('git exited 1');
    expect(msg).not.toContain('git exited 1:');
  });

  test('tells the user to pause-and-commit-manually (not auto-retry)', () => {
    const msg = formatCommitFailureMessage(baseArgs);
    expect(msg.toLowerCase()).toContain('pausing vibe');
    expect(msg.toLowerCase()).toContain('commit manually');
    expect(msg).not.toContain('restart `lauren vibe`');
  });
});

describe('RunFailure', () => {
  test('Error.message has the phase prefix; rawMessage does not', () => {
    const f = new RunFailure('commit', 'something went wrong', '1.2');
    expect(f.message).toBe('commit: something went wrong');
    expect(f.rawMessage).toBe('something went wrong');
    expect(f.phase).toBe('commit');
    expect(f.stepId).toBe('1.2');
  });
});

describe('planCommitMessage', () => {
  test('includes the slug so single-unit plan commits are resumable', () => {
    expect(
      planCommitMessage({
        slug: 'single-plan',
        title: 'Single plan',
        path: '.lauren/plans/single-plan.md',
        target_repos: [],
        status: 'ready',
        cancel_requested: false,
        created_at: '2026-05-08T12:00:00Z',
        started_at: null,
        finished_at: null,
        failure: null,
        steps: null,
      }),
    ).toBe('single-plan: Plan — Single plan');
  });
});

describe('runPlan zero-diff already-done handling', () => {
  let planSlug: string;
  let planPath: string;
  let createdLogDirs: string[];

  function makeStep(id: string, title: string, status: StepEntry['status'] = 'pending'): StepEntry {
    return {
      id,
      title,
      status,
      commit_subject: null,
      started_at: null,
      finished_at: null,
    };
  }

  beforeEach(async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    planSlug = `executor-test-${stamp}`;
    planPath = path.join(PLANS_DIR, `${planSlug}.md`);
    createdLogDirs = [path.join(LOG_ROOT, planSlug)];
    await fs.mkdir(PLANS_DIR, { recursive: true });
    await fs.writeFile(
      planPath,
      `---\nname: ${planSlug}\ndescription: |\n  test\n---\n\n# ${planSlug}\n\n` +
        '### Step 1.1 — Already done\n\nbody\n',
      'utf8',
    );
    vi.mocked(streamSubprocess).mockReset();
    vi.mocked(runCodexReview).mockReset();
    vi.mocked(workingTreeDirty).mockReset();
    vi.mocked(gitAddAll).mockReset();
    vi.mocked(gitCommit).mockReset();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    await fs.rm(planPath, { force: true });
    for (const dir of createdLogDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  test('marks Step done with null commit_subject when implement produces no diff', async () => {
    vi.mocked(streamSubprocess).mockResolvedValue(0);
    vi.mocked(workingTreeDirty).mockReturnValue(false);

    const plan: Plan = {
      slug: planSlug,
      title: planSlug,
      path: path.relative(process.cwd(), planPath),
      target_repos: [],
      status: 'implementing',
      cancel_requested: false,
      created_at: '2026-05-08T12:00:00Z',
      started_at: '2026-05-08T12:05:00Z',
      finished_at: null,
      failure: null,
      steps: [makeStep('1.1', 'Already done')],
    };
    const fakeRepo = { name: 'main', path: '.', root: process.cwd() };
    const updates: StepEntry[][] = [];

    await runPlan({
      plan,
      dryRun: false,
      targetRepos: [fakeRepo],
      onStepUpdate: async (steps) => {
        updates.push(steps.map((s) => ({ ...s })));
      },
    });

    expect(runCodexReview).not.toHaveBeenCalled();
    expect(gitAddAll).not.toHaveBeenCalled();
    expect(gitCommit).not.toHaveBeenCalled();
    const last = updates.at(-1)!;
    expect(last[0]?.status).toBe('done');
    expect(last[0]?.commit_subject).toBeNull();
  });

  test('records commit_subject normally when implement produces a diff', async () => {
    vi.mocked(streamSubprocess).mockResolvedValue(0);
    // dirty after implement (true), still dirty before commit step (true), then
    // gitCommit is called and we no longer care.
    vi.mocked(workingTreeDirty).mockReturnValue(true);
    // First call (dirtyBeforeStart) needs to return false so we don't bail.
    vi.mocked(workingTreeDirty).mockReturnValueOnce(false);
    vi.mocked(runCodexReview).mockResolvedValue({ code: 0, reviewText: '' });
    vi.mocked(gitCommit).mockReturnValue({ code: 0, stdout: '', stderr: '' });

    const plan: Plan = {
      slug: planSlug,
      title: planSlug,
      path: path.relative(process.cwd(), planPath),
      target_repos: [],
      status: 'implementing',
      cancel_requested: false,
      created_at: '2026-05-08T12:00:00Z',
      started_at: '2026-05-08T12:05:00Z',
      finished_at: null,
      failure: null,
      steps: [makeStep('1.1', 'Already done')],
    };
    const fakeRepo = { name: 'main', path: '.', root: process.cwd() };
    const updates: StepEntry[][] = [];

    await runPlan({
      plan,
      dryRun: false,
      targetRepos: [fakeRepo],
      onStepUpdate: async (steps) => {
        updates.push(steps.map((s) => ({ ...s })));
      },
    });

    expect(gitAddAll).toHaveBeenCalled();
    expect(gitCommit).toHaveBeenCalled();
    const last = updates.at(-1)!;
    expect(last[0]?.status).toBe('done');
    expect(last[0]?.commit_subject).toBe(`${planSlug}: Step 1.1 — Already done`);
  });

  test('pauses at a checkpoint after the matching Step commits', async () => {
    await fs.writeFile(
      planPath,
      `---\nname: ${planSlug}\ndescription: |\n  test\n---\n\n# ${planSlug}\n\n` +
        '### Step 1.1 — First\n\n### Human Checkpoint — Manual setup\n\n' +
        '[Instructions](./demo.cp1.html)\n\n### Step 1.2 — Second\n',
      'utf8',
    );
    vi.mocked(streamSubprocess).mockResolvedValue(0);
    // dirtyBeforeStart=false then dirtyAfterImplement=true so we proceed to commit.
    vi.mocked(workingTreeDirty).mockReturnValue(true);
    vi.mocked(workingTreeDirty).mockReturnValueOnce(false);
    vi.mocked(runCodexReview).mockResolvedValue({ code: 0, reviewText: '' });
    vi.mocked(gitCommit).mockReturnValue({ code: 0, stdout: '', stderr: '' });

    const plan: Plan = {
      slug: planSlug,
      title: planSlug,
      path: path.relative(process.cwd(), planPath),
      target_repos: [],
      status: 'implementing',
      cancel_requested: false,
      created_at: '2026-05-08T12:00:00Z',
      started_at: '2026-05-08T12:05:00Z',
      finished_at: null,
      failure: null,
      steps: [makeStep('1.1', 'First'), makeStep('1.2', 'Second')],
      checkpoints: [
        {
          id: 'cp-1',
          title: 'Manual setup',
          html_path: '.lauren/plans/demo.cp1.html',
          after_step_id: '1.1',
          status: 'pending',
          acknowledged_at: null,
        },
      ],
    };
    const fakeRepo = { name: 'main', path: '.', root: process.cwd() };

    const result = await runPlan({
      plan,
      dryRun: false,
      targetRepos: [fakeRepo],
    });

    expect(result).toEqual({ kind: 'paused-at-checkpoint', checkpoint_id: 'cp-1' });
    // Only Step 1.1 ran — Step 1.2 was deferred until the user acks.
    expect(gitCommit).toHaveBeenCalledTimes(1);
  });

  test('pauses at a leading checkpoint before any Step runs', async () => {
    const plan: Plan = {
      slug: planSlug,
      title: planSlug,
      path: path.relative(process.cwd(), planPath),
      target_repos: [],
      status: 'implementing',
      cancel_requested: false,
      created_at: '2026-05-08T12:00:00Z',
      started_at: '2026-05-08T12:05:00Z',
      finished_at: null,
      failure: null,
      steps: [makeStep('1.1', 'First')],
      checkpoints: [
        {
          id: 'cp-1',
          title: 'Configure env first',
          html_path: '.lauren/plans/demo.cp1.html',
          after_step_id: null,
          status: 'pending',
          acknowledged_at: null,
        },
      ],
    };
    const fakeRepo = { name: 'main', path: '.', root: process.cwd() };

    const result = await runPlan({
      plan,
      dryRun: false,
      targetRepos: [fakeRepo],
    });

    expect(result).toEqual({ kind: 'paused-at-checkpoint', checkpoint_id: 'cp-1' });
    expect(streamSubprocess).not.toHaveBeenCalled();
  });

  test('completes normally when all checkpoints are already done', async () => {
    vi.mocked(streamSubprocess).mockResolvedValue(0);
    vi.mocked(workingTreeDirty).mockReturnValue(false);

    const plan: Plan = {
      slug: planSlug,
      title: planSlug,
      path: path.relative(process.cwd(), planPath),
      target_repos: [],
      status: 'implementing',
      cancel_requested: false,
      created_at: '2026-05-08T12:00:00Z',
      started_at: '2026-05-08T12:05:00Z',
      finished_at: null,
      failure: null,
      steps: [makeStep('1.1', 'First', 'done'), makeStep('1.2', 'Second')],
      checkpoints: [
        {
          id: 'cp-1',
          title: 'Done already',
          html_path: '.lauren/plans/demo.cp1.html',
          after_step_id: '1.1',
          status: 'done',
          acknowledged_at: '2026-05-08T12:30:00Z',
        },
      ],
    };
    const fakeRepo = { name: 'main', path: '.', root: process.cwd() };

    const result = await runPlan({ plan, dryRun: false, targetRepos: [fakeRepo] });

    expect(result).toEqual({ kind: 'completed' });
  });

  test('pauses at a pending checkpoint after an already-completed Step', async () => {
    const plan: Plan = {
      slug: planSlug,
      title: planSlug,
      path: path.relative(process.cwd(), planPath),
      target_repos: [],
      status: 'implementing',
      cancel_requested: false,
      created_at: '2026-05-08T12:00:00Z',
      started_at: '2026-05-08T12:05:00Z',
      finished_at: null,
      failure: null,
      steps: [makeStep('1.1', 'First', 'done'), makeStep('1.2', 'Second')],
      checkpoints: [
        {
          id: 'cp-2',
          title: 'Second manual setup',
          html_path: '.lauren/plans/demo.cp2.html',
          after_step_id: '1.1',
          status: 'pending',
          acknowledged_at: null,
        },
      ],
    };
    const fakeRepo = { name: 'main', path: '.', root: process.cwd() };

    const result = await runPlan({ plan, dryRun: false, targetRepos: [fakeRepo] });

    expect(result).toEqual({ kind: 'paused-at-checkpoint', checkpoint_id: 'cp-2' });
    expect(streamSubprocess).not.toHaveBeenCalled();
  });

  test('does not rerun a single-unit plan after its trailing checkpoint is acknowledged', async () => {
    const plan: Plan = {
      slug: planSlug,
      title: planSlug,
      path: path.relative(process.cwd(), planPath),
      target_repos: [],
      status: 'implementing',
      cancel_requested: false,
      created_at: '2026-05-08T12:00:00Z',
      started_at: '2026-05-08T12:05:00Z',
      finished_at: null,
      failure: null,
      steps: null,
      checkpoints: [
        {
          id: 'cp-1',
          title: 'Manual setup',
          html_path: '.lauren/plans/demo.cp1.html',
          after_step_id: '__unit__',
          status: 'done',
          acknowledged_at: '2026-05-08T12:30:00Z',
        },
      ],
    };
    const fakeRepo = { name: 'main', path: '.', root: process.cwd() };

    const result = await runPlan({ plan, dryRun: false, targetRepos: [fakeRepo] });

    expect(result).toEqual({ kind: 'completed' });
    expect(streamSubprocess).not.toHaveBeenCalled();
    expect(gitCommit).not.toHaveBeenCalled();
  });

  test('marks the commit phase failed when git add throws', async () => {
    vi.mocked(streamSubprocess).mockResolvedValue(0);
    vi.mocked(workingTreeDirty).mockReturnValue(true);
    vi.mocked(workingTreeDirty).mockReturnValueOnce(false);
    vi.mocked(runCodexReview).mockResolvedValue({ code: 0, reviewText: '' });
    vi.mocked(gitAddAll).mockImplementation(() => {
      throw new Error('git add -A exited 128: index.lock exists');
    });

    const plan: Plan = {
      slug: planSlug,
      title: planSlug,
      path: path.relative(process.cwd(), planPath),
      target_repos: [],
      status: 'implementing',
      cancel_requested: false,
      created_at: '2026-05-08T12:00:00Z',
      started_at: '2026-05-08T12:05:00Z',
      finished_at: null,
      failure: null,
      steps: [makeStep('1.1', 'Already done')],
    };
    const fakeRepo = { name: 'main', path: '.', root: process.cwd() };
    const progress: ProgressSink = {
      appendLog: vi.fn(),
      beginItem: vi.fn(),
      endItem: vi.fn(),
      markItemDone: vi.fn(),
      beginPhase: vi.fn(),
      endPhase: vi.fn(),
    };

    await expect(
      runPlan({
        plan,
        dryRun: false,
        targetRepos: [fakeRepo],
        progress,
      }),
    ).rejects.toMatchObject({
      phase: 'commit',
      stepId: '1.1',
      rawMessage: 'git add -A exited 128: index.lock exists',
    });

    expect(progress.endPhase).toHaveBeenCalledWith('1.1', 'commit', 'failed');
    expect(progress.endItem).toHaveBeenCalledWith('1.1', 'failed');
    expect(gitCommit).not.toHaveBeenCalled();
  });
});
