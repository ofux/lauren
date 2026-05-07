import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { InboxStore, InboxStoreFormatError } from './inbox.js';
import { type Plan, PlanNotFound, SlugCollision } from './types.js';

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    slug: 'demo-plan',
    title: 'Demo plan',
    path: '.lauren/plans/demo-plan.md',
    target_repos: [],
    status: 'enqueued',
    cancel_requested: false,
    created_at: '2026-05-08T12:00:00Z',
    started_at: null,
    finished_at: null,
    failure: null,
    prs: null,
    ...overrides,
  };
}

describe('InboxStore', () => {
  let tmpDir: string;
  let store: InboxStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lauren-inbox-'));
    store = new InboxStore({
      path: path.join(tmpDir, 'inbox.json'),
      lockPath: path.join(tmpDir, 'inbox.json.lock'),
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('read() returns [] when file is missing', async () => {
    expect(await store.read()).toEqual([]);
  });

  test('read() throws a typed error for malformed JSON', async () => {
    await fs.writeFile(path.join(tmpDir, 'inbox.json'), '{', 'utf8');
    await expect(store.read()).rejects.toBeInstanceOf(InboxStoreFormatError);
    await expect(store.read()).rejects.toThrow(/malformed JSON/);
  });

  test('read() throws a typed error for unsupported schema versions', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'inbox.json'),
      JSON.stringify({ version: 999, plans: [] }),
      'utf8',
    );
    await expect(store.read()).rejects.toBeInstanceOf(InboxStoreFormatError);
    await expect(store.read()).rejects.toThrow(/schema version 999 not supported/);
  });

  test('read() migrates legacy inbox status (pending → enqueued)', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'inbox.json'),
      JSON.stringify({
        version: 1,
        plans: [{ slug: 'a', title: 'A', path: '.lauren/plans/a.md', status: 'pending' }],
      }),
      'utf8',
    );
    const plans = await store.read();
    expect(plans[0]?.status).toBe('enqueued');
    expect(plans[0]?.cancel_requested).toBe(false);
  });

  test('add() persists a plan and read() returns it', async () => {
    const plan = makePlan();
    await store.add(plan);
    expect(await store.read()).toEqual([plan]);
  });

  test('add() preserves FIFO order across multiple plans', async () => {
    await store.add(makePlan({ slug: 'first' }));
    await store.add(makePlan({ slug: 'second' }));
    await store.add(makePlan({ slug: 'third' }));
    expect((await store.read()).map((p) => p.slug)).toEqual(['first', 'second', 'third']);
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

  test('remove() returns the plan and drops it from the queue', async () => {
    await store.add(makePlan({ slug: 'a' }));
    await store.add(makePlan({ slug: 'b' }));
    const removed = await store.remove('a');
    expect(removed.slug).toBe('a');
    expect((await store.read()).map((p) => p.slug)).toEqual(['b']);
  });

  test('remove() throws PlanNotFound for missing slug', async () => {
    await expect(store.remove('ghost')).rejects.toBeInstanceOf(PlanNotFound);
  });

  test('writes are atomic across concurrent adds', async () => {
    await Promise.all([
      store.add(makePlan({ slug: 'a' })),
      store.add(makePlan({ slug: 'b' })),
      store.add(makePlan({ slug: 'c' })),
    ]);
    const slugs = (await store.read()).map((p) => p.slug).sort();
    expect(slugs).toEqual(['a', 'b', 'c']);
  });
});
