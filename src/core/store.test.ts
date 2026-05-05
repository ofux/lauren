import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { TodoStore } from './store.js';
import { InProgressLocked, type Plan, PlanNotFound, SlugCollision } from './types.js';

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    slug: 'demo-plan',
    title: 'Demo plan',
    path: '.lauren/plans/demo-plan.md',
    status: 'pending',
    created_at: '2026-05-08T12:00:00Z',
    started_at: null,
    finished_at: null,
    failure: null,
    ...overrides,
  };
}

describe('TodoStore', () => {
  let tmpDir: string;
  let store: TodoStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lauren-store-'));
    store = new TodoStore({
      path: path.join(tmpDir, 'todo.json'),
      lockPath: path.join(tmpDir, 'todo.json.lock'),
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('read() returns [] when file is missing', async () => {
    expect(await store.read()).toEqual([]);
  });

  test('add() persists a plan and read() returns it', async () => {
    const plan = makePlan();
    await store.add(plan);
    expect(await store.read()).toEqual([plan]);
  });

  test('add() throws SlugCollision on duplicate slug', async () => {
    await store.add(makePlan({ slug: 'dup' }));
    await expect(store.add(makePlan({ slug: 'dup', title: 'second' }))).rejects.toBeInstanceOf(
      SlugCollision,
    );
  });

  test('find() returns null for missing slug and the plan otherwise', async () => {
    const plan = makePlan({ slug: 'findable' });
    await store.add(plan);
    expect(await store.find('findable')).toEqual(plan);
    expect(await store.find('nope')).toBeNull();
  });

  test('remove() throws PlanNotFound for missing slug', async () => {
    await expect(store.remove('ghost')).rejects.toBeInstanceOf(PlanNotFound);
  });

  test('remove() throws InProgressLocked when in_progress and allowInProgress is unset', async () => {
    await store.add(makePlan({ slug: 'running', status: 'in_progress' }));
    await expect(store.remove('running')).rejects.toBeInstanceOf(InProgressLocked);
    expect(await store.read()).toHaveLength(1);
  });

  test('remove({allowInProgress: true}) succeeds for an in_progress plan', async () => {
    await store.add(makePlan({ slug: 'running', status: 'in_progress' }));
    const removed = await store.remove('running', { allowInProgress: true });
    expect(removed.slug).toBe('running');
    expect(await store.read()).toEqual([]);
  });

  test('update() merges fields and ignores attempts to change slug', async () => {
    await store.add(makePlan({ slug: 'orig', title: 'Old' }));
    const updated = await store.update('orig', {
      title: 'New',
      status: 'done',
      // @ts-expect-error — runtime should ignore slug changes even if forced.
      slug: 'should-be-ignored',
    });
    expect(updated.slug).toBe('orig');
    expect(updated.title).toBe('New');
    expect(updated.status).toBe('done');
  });

  test('update() honors the in_progress lock identically to remove', async () => {
    await store.add(makePlan({ slug: 'running', status: 'in_progress' }));
    await expect(store.update('running', { title: 'Nope' })).rejects.toBeInstanceOf(
      InProgressLocked,
    );
    await expect(
      store.update('running', { title: 'Yes' }, { allowInProgress: true }),
    ).resolves.toMatchObject({ title: 'Yes' });
  });

  describe('move()', () => {
    beforeEach(async () => {
      await store.add(makePlan({ slug: 'a' }));
      await store.add(makePlan({ slug: 'b' }));
      await store.add(makePlan({ slug: 'c' }));
    });

    test('toFront moves a plan to the head', async () => {
      await store.move('c', { toFront: true });
      expect((await store.read()).map((p) => p.slug)).toEqual(['c', 'a', 'b']);
    });

    test('toBack moves a plan to the tail', async () => {
      await store.move('a', { toBack: true });
      expect((await store.read()).map((p) => p.slug)).toEqual(['b', 'c', 'a']);
    });

    test('before <slug> inserts directly before the target', async () => {
      await store.move('c', { before: 'a' });
      expect((await store.read()).map((p) => p.slug)).toEqual(['c', 'a', 'b']);
    });

    test('before <unknown> throws PlanNotFound and leaves order unchanged', async () => {
      const before = (await store.read()).map((p) => p.slug);
      await expect(store.move('a', { before: 'ghost' })).rejects.toBeInstanceOf(PlanNotFound);
      expect((await store.read()).map((p) => p.slug)).toEqual(before);
    });

    test('move() of an in_progress plan respects the lock', async () => {
      await store.update('b', { status: 'in_progress' });
      await expect(store.move('b', { toFront: true })).rejects.toBeInstanceOf(InProgressLocked);
    });
  });

  describe('reorderPending()', () => {
    test('accepts an exact permutation of pending slugs', async () => {
      await store.add(makePlan({ slug: 'a' }));
      await store.add(makePlan({ slug: 'b' }));
      await store.add(makePlan({ slug: 'c' }));
      await store.reorderPending(['c', 'a', 'b']);
      expect((await store.read()).map((p) => p.slug)).toEqual(['c', 'a', 'b']);
    });

    test('throws when slugs are missing or extra', async () => {
      await store.add(makePlan({ slug: 'a' }));
      await store.add(makePlan({ slug: 'b' }));
      await expect(store.reorderPending(['a'])).rejects.toThrow(/reorder mismatch/);
      await expect(store.reorderPending(['a', 'b', 'c'])).rejects.toThrow(/reorder mismatch/);
    });

    test('preserves the position of non-pending plans', async () => {
      await store.add(makePlan({ slug: 'a' }));
      await store.add(makePlan({ slug: 'done1', status: 'done' }));
      await store.add(makePlan({ slug: 'b' }));
      await store.add(makePlan({ slug: 'c' }));
      await store.reorderPending(['c', 'b', 'a']);
      // Pending slots are filled in encounter order with the new permutation;
      // the 'done1' plan stays in its slot (index 1).
      expect((await store.read()).map((p) => p.slug)).toEqual(['c', 'done1', 'b', 'a']);
    });
  });
});
