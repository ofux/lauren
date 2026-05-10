import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PlanStore, PlanStoreFormatError } from './store.js';
import {
  ImplementingLocked,
  type Plan,
  PlanNotFound,
  PlanPreconditionFailed,
  PlanSelfMerge,
  SlugCollision,
} from './types.js';

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    slug: 'demo-plan',
    title: 'Demo plan',
    path: '.lauren/plans/demo-plan.md',
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

function makeStore(tmpDir: string): PlanStore {
  return new PlanStore({
    path: path.join(tmpDir, 'plans.json'),
    lockPath: path.join(tmpDir, 'plans.json.lock'),
  });
}

describe('PlanStore', () => {
  let tmpDir: string;
  let store: PlanStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lauren-store-'));
    store = makeStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('read() returns [] when file is missing', async () => {
    expect(await store.read()).toEqual([]);
  });

  test('read() throws a typed error for malformed JSON', async () => {
    await fs.writeFile(path.join(tmpDir, 'plans.json'), '{', 'utf8');
    await expect(store.read()).rejects.toBeInstanceOf(PlanStoreFormatError);
    await expect(store.read()).rejects.toThrow(/malformed JSON/);
  });

  test('read() throws a typed error for unsupported schema versions', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'plans.json'),
      JSON.stringify({ version: 999, plans: [] }),
      'utf8',
    );
    await expect(store.read()).rejects.toBeInstanceOf(PlanStoreFormatError);
    await expect(store.read()).rejects.toThrow(/schema version 999 not supported/);
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

  test('remove() throws ImplementingLocked when implementing and allowImplementing is unset', async () => {
    await store.add(makePlan({ slug: 'running', status: 'implementing' }));
    await expect(store.remove('running')).rejects.toBeInstanceOf(ImplementingLocked);
    expect(await store.read()).toHaveLength(1);
  });

  test('remove({allowImplementing: true}) succeeds for an implementing plan', async () => {
    await store.add(makePlan({ slug: 'running', status: 'implementing' }));
    const removed = await store.remove('running', { allowImplementing: true });
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

  test('update() honors the implementing lock identically to remove', async () => {
    await store.add(makePlan({ slug: 'running', status: 'implementing' }));
    await expect(store.update('running', { title: 'Nope' })).rejects.toBeInstanceOf(
      ImplementingLocked,
    );
    await expect(
      store.update('running', { title: 'Yes' }, { allowImplementing: true }),
    ).resolves.toMatchObject({ title: 'Yes' });
  });

  test('update() throws PlanPreconditionFailed and leaves the row untouched', async () => {
    await store.add(makePlan({ slug: 'claim-me', status: 'cancelled' }));
    await expect(
      store.update(
        'claim-me',
        { status: 'implementing' },
        { precondition: (p) => p.status === 'ready' },
      ),
    ).rejects.toBeInstanceOf(PlanPreconditionFailed);
    expect((await store.find('claim-me'))?.status).toBe('cancelled');
  });

  test('update() with a satisfied precondition applies the patch', async () => {
    await store.add(makePlan({ slug: 'claim-me', status: 'ready' }));
    const updated = await store.update(
      'claim-me',
      { status: 'implementing' },
      { precondition: (p) => p.status === 'ready' },
    );
    expect(updated.status).toBe('implementing');
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

    test('move() of an implementing plan respects the lock', async () => {
      await store.update('b', { status: 'implementing' });
      await expect(store.move('b', { toFront: true })).rejects.toBeInstanceOf(ImplementingLocked);
    });
  });

  describe('reorderReady()', () => {
    test('accepts an exact permutation of ready slugs', async () => {
      await store.add(makePlan({ slug: 'a' }));
      await store.add(makePlan({ slug: 'b' }));
      await store.add(makePlan({ slug: 'c' }));
      await store.reorderReady(['c', 'a', 'b']);
      expect((await store.read()).map((p) => p.slug)).toEqual(['c', 'a', 'b']);
    });

    test('throws when slugs are missing or extra', async () => {
      await store.add(makePlan({ slug: 'a' }));
      await store.add(makePlan({ slug: 'b' }));
      await expect(store.reorderReady(['a'])).rejects.toThrow(/reorder mismatch/);
      await expect(store.reorderReady(['a', 'b', 'c'])).rejects.toThrow(/reorder mismatch/);
    });

    test('preserves the position of non-ready plans', async () => {
      await store.add(makePlan({ slug: 'a' }));
      await store.add(makePlan({ slug: 'done1', status: 'done' }));
      await store.add(makePlan({ slug: 'b' }));
      await store.add(makePlan({ slug: 'c' }));
      await store.reorderReady(['c', 'b', 'a']);
      // Ready slots are filled in encounter order with the new permutation;
      // the 'done1' plan stays in its slot (index 1).
      expect((await store.read()).map((p) => p.slug)).toEqual(['c', 'done1', 'b', 'a']);
    });
  });

  describe('atomicMerge()', () => {
    test('rejects self-merges before mutating the queue or files', async () => {
      await store.add(makePlan({ slug: 'a', title: 'A' }));

      await expect(
        store.atomicMerge({
          targetSlug: 'a',
          fromSlug: 'a',
          newTitle: 'Merged',
          bodyWriter: async () => {
            throw new Error('body writer should not run');
          },
        }),
      ).rejects.toBeInstanceOf(PlanSelfMerge);

      expect(await store.read()).toMatchObject([{ slug: 'a', title: 'A' }]);
    });

    test('rolls back body writes when the queue write fails', async () => {
      const stateDir = path.join(tmpDir, 'readonly-state');
      await fs.mkdir(stateDir);
      const failingStore = new PlanStore({
        path: path.join(stateDir, 'plans.json'),
        lockPath: path.join(tmpDir, 'plans.json.lock'),
      });
      await failingStore.add(makePlan({ slug: 'a', title: 'A' }));
      await failingStore.add(makePlan({ slug: 'b', title: 'B' }));

      const targetFile = path.join(tmpDir, 'target.md');
      await fs.writeFile(targetFile, 'original\n', 'utf8');
      await fs.chmod(stateDir, 0o555);
      try {
        await expect(
          failingStore.atomicMerge({
            targetSlug: 'a',
            fromSlug: 'b',
            newTitle: 'Merged',
            bodyWriter: async () => {
              await fs.writeFile(targetFile, 'merged\n', 'utf8');
              return {
                rollback: async () => {
                  await fs.writeFile(targetFile, 'original\n', 'utf8');
                },
              };
            },
          }),
        ).rejects.toThrow();
      } finally {
        await fs.chmod(stateDir, 0o755);
      }

      expect(await fs.readFile(targetFile, 'utf8')).toBe('original\n');
      expect((await failingStore.read()).map((p) => p.slug)).toEqual(['a', 'b']);
    });
  });
});
