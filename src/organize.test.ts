import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PLANS_DIR } from './core/paths.js';
import { PlanStore } from './core/store.js';
import type { Plan } from './core/types.js';
import { type BrainCancelState, processEnqueuedPlan } from './organize.js';

vi.mock('./brain.js', () => ({
  brainPlacePlan: vi.fn(),
  applyPlaceDecision: vi.fn(async () => 'placed (mocked)'),
}));

import { applyPlaceDecision, brainPlacePlan } from './brain.js';

function makePlan(prefix: string, slug: string): Plan {
  return {
    slug,
    title: `${slug} title`,
    path: path.join('.lauren', 'plans', `${prefix}-${slug}.md`),
    target_repos: [],
    status: 'enqueued',
    cancel_requested: false,
    created_at: '2026-05-08T12:00:00Z',
    started_at: null,
    finished_at: null,
    failure: null,
    steps: null,
  };
}

describe('processEnqueuedPlan', () => {
  let tmpDir: string;
  let store: PlanStore;
  let planPrefix: string;
  let state: BrainCancelState;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lauren-organize-'));
    planPrefix = path.basename(tmpDir);
    store = new PlanStore({
      path: path.join(tmpDir, 'plans.json'),
      lockPath: path.join(tmpDir, 'plans.json.lock'),
    });
    state = { current: null, controller: null };
    vi.mocked(brainPlacePlan).mockReset();
    vi.mocked(applyPlaceDecision).mockReset();
    vi.mocked(applyPlaceDecision).mockResolvedValue('placed (mocked)');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    const entries = await fs.readdir(PLANS_DIR).catch(() => []);
    await Promise.all(
      entries
        .filter((name) => name.startsWith(`${planPrefix}-`))
        .map((name) => fs.unlink(path.join(PLANS_DIR, name))),
    );
  });

  test('drops the row when cancel_requested lands between brain return and ready transition', async () => {
    const plan = makePlan(planPrefix, 'pending-cancel');
    await fs.mkdir(PLANS_DIR, { recursive: true });
    const planFile = path.join(PLANS_DIR, path.basename(plan.path));
    await fs.writeFile(planFile, '# plan body\n', 'utf8');
    await store.add(plan);

    // Simulate the race: cancel.ts flips cancel_requested=true while brain
    // is still working. organize.ts must detect this via the precondition
    // and abort the ready transition.
    vi.mocked(brainPlacePlan).mockImplementation(async () => {
      await store.update(plan.slug, { cancel_requested: true }, { allowPreparing: true });
      return { kind: 'insert', position: 0, reasoning: '' };
    });

    await processEnqueuedPlan({ plan, store, state });

    expect(await store.find(plan.slug)).toBeNull();
    await expect(fs.access(planFile)).rejects.toThrow();
    // The ready transition was aborted, so applyPlaceDecision must NOT have run.
    expect(applyPlaceDecision).not.toHaveBeenCalled();
  });

  test('transitions to ready and runs placement when no cancel arrives', async () => {
    const plan = makePlan(planPrefix, 'happy-path');
    await fs.mkdir(PLANS_DIR, { recursive: true });
    const planFile = path.join(PLANS_DIR, path.basename(plan.path));
    await fs.writeFile(planFile, '# plan body\n', 'utf8');
    await store.add(plan);

    vi.mocked(brainPlacePlan).mockResolvedValue({
      kind: 'insert',
      position: 0,
      reasoning: '',
    });

    await processEnqueuedPlan({ plan, store, state });

    const after = await store.find(plan.slug);
    expect(after?.status).toBe('ready');
    expect(after?.cancel_requested).toBe(false);
    expect(applyPlaceDecision).toHaveBeenCalledTimes(1);
  });
});
