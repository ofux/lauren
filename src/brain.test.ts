import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  applyOrganizeDecision,
  applyPlaceDecision,
  formatReadyForBrain,
  readReadySummaries,
} from './brain.js';
import { PLANS_DIR } from './core/paths.js';
import { TodoStore } from './core/store.js';
import { type Plan, planFilePath } from './core/types.js';

function makePlan(prefix: string, slug: string): Plan {
  return {
    slug,
    title: `${slug} title`,
    path: path.join('.lauren', 'plans', `${prefix}-${slug}.md`),
    target_repos: [],
    status: 'ready',
    cancel_requested: false,
    created_at: '2026-05-08T12:00:00Z',
    started_at: null,
    finished_at: null,
    failure: null,
    prs: null,
  };
}

describe('applyOrganizeDecision', () => {
  let tmpDir: string;
  let store: TodoStore;
  let planPrefix: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lauren-brain-'));
    planPrefix = path.basename(tmpDir);
    store = new TodoStore({
      path: path.join(tmpDir, 'todo.json'),
      lockPath: path.join(tmpDir, 'todo.json.lock'),
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    const entries = await fs.readdir(PLANS_DIR).catch(() => []);
    await Promise.all(
      entries
        .filter((name) => name.startsWith(`${planPrefix}-`))
        .map((name) => fs.rm(path.join(PLANS_DIR, name), { force: true })),
    );
  });

  test('applies merges before reorder even when the model lists reorder first', async () => {
    for (const slug of ['a', 'b', 'c']) {
      const plan = makePlan(planPrefix, slug);
      await fs.mkdir(path.dirname(planFilePath(plan)), { recursive: true });
      await fs.writeFile(
        planFilePath(plan),
        `---\nname: ${slug}\ndescription: |\n  test plan ${slug}\n---\n\n# ${slug}\n`,
        'utf8',
      );
      await store.add(plan);
    }

    const mergedBody =
      '---\nname: a\ndescription: |\n  merged plan covering a and b\n---\n\n# merged\n';
    const summary = await applyOrganizeDecision(store, {
      operations: [
        { op: 'reorder', order: ['a', 'c'] },
        {
          op: 'merge',
          into: 'a',
          from: 'b',
          merged_title: 'A and B',
          merged_markdown: mergedBody,
        },
      ],
    });

    expect(summary).toEqual(["  merged 'b' → 'a'", '  reordered 2 ready plan(s)']);
    expect((await store.read()).map((p) => p.slug)).toEqual(['a', 'c']);
    await expect(fs.readFile(path.join(PLANS_DIR, `${planPrefix}-a.md`), 'utf8')).resolves.toBe(
      mergedBody,
    );
    await expect(fs.access(path.join(PLANS_DIR, `${planPrefix}-b.md`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('merge materializes a PR list on the target from the merged markdown', async () => {
    for (const slug of ['a', 'b']) {
      const plan = makePlan(planPrefix, slug);
      await fs.mkdir(path.dirname(planFilePath(plan)), { recursive: true });
      await fs.writeFile(
        planFilePath(plan),
        `---\nname: ${slug}\ndescription: |\n  test plan ${slug}\n---\n\n# ${slug}\n`,
        'utf8',
      );
      await store.add(plan);
    }

    const mergedBody =
      `---\nname: a\ndescription: |\n  merged a+b\n---\n\n` +
      `### PR 1.1 — First\nbody\n\n### PR 1.2 — Second\nbody\n`;
    await applyOrganizeDecision(store, {
      operations: [
        { op: 'merge', into: 'a', from: 'b', merged_title: 'A and B', merged_markdown: mergedBody },
      ],
    });

    const target = (await store.read()).find((p) => p.slug === 'a');
    expect(target?.prs?.map((e) => [e.id, e.title, e.status])).toEqual([
      ['1.1', 'First', 'pending'],
      ['1.2', 'Second', 'pending'],
    ]);
  });

  test('places valid insert decisions at the requested ready position', async () => {
    const existing = makePlan(planPrefix, 'a');
    const newPlan = makePlan(planPrefix, 'b');
    await store.add(existing);
    await store.add(newPlan);

    const summary = await applyPlaceDecision(store, newPlan, {
      decision: 'insert',
      position: 0,
    });

    expect(summary).toContain("placed 'b' at position 0");
    expect((await store.read()).map((p) => p.slug)).toEqual(['b', 'a']);
  });

  test('leaves malformed placement decisions at the back of the queue', async () => {
    const existing = makePlan(planPrefix, 'a');
    const newPlan = makePlan(planPrefix, 'b');
    await store.add(existing);
    await store.add(newPlan);

    const summary = await applyPlaceDecision(store, newPlan, {});

    expect(summary).toBe("unknown brain decision; left 'b' at end of queue");
    expect((await store.read()).map((p) => p.slug)).toEqual(['a', 'b']);
  });

  test('leaves insert decisions without a valid position at the back of the queue', async () => {
    const existing = makePlan(planPrefix, 'a');
    const newPlan = makePlan(planPrefix, 'b');
    await store.add(existing);
    await store.add(newPlan);

    const summary = await applyPlaceDecision(store, newPlan, {
      decision: 'insert',
      position: '0abc',
    });

    expect(summary).toBe("insert decision missing valid position; left 'b' at end of queue");
    expect((await store.read()).map((p) => p.slug)).toEqual(['a', 'b']);
  });

  test.each([
    -1, 0.5,
  ])('leaves normalized insert decisions with invalid position %s at the back of the queue', async (position) => {
    const existing = makePlan(planPrefix, 'a');
    const newPlan = makePlan(planPrefix, 'b');
    await store.add(existing);
    await store.add(newPlan);

    const summary = await applyPlaceDecision(store, newPlan, {
      kind: 'insert',
      position,
    });

    expect(summary).toBe("insert decision missing valid position; left 'b' at end of queue");
    expect((await store.read()).map((p) => p.slug)).toEqual(['a', 'b']);
  });

  test('formatReadyForBrain emits descriptions + paths but not full bodies', async () => {
    const plan = makePlan(planPrefix, 'sample');
    await fs.mkdir(path.dirname(planFilePath(plan)), { recursive: true });
    const bodyMarker = 'IMPLEMENTATION_DETAILS_THAT_SHOULD_NOT_LEAK';
    const fileContents =
      `---\nname: sample\ndescription: |\n  Adds the sample feature.\n  Touches src/sample/.\n---\n\n` +
      `# Sample\n\n${bodyMarker}\n\nMore body lines.\n`;
    await fs.writeFile(planFilePath(plan), fileContents, 'utf8');
    await store.add(plan);

    const summaries = await readReadySummaries(store);
    const formatted = formatReadyForBrain(summaries);

    expect(formatted).toContain('slug: `sample`');
    expect(formatted).toContain(`path: \`${plan.path}\``);
    expect(formatted).toContain('Adds the sample feature.');
    expect(formatted).toContain('Touches src/sample/.');
    expect(formatted).not.toContain(bodyMarker);
  });

  test('readReadySummaries falls back to an excerpt when frontmatter is missing', async () => {
    const plan = makePlan(planPrefix, 'oldstyle');
    await fs.mkdir(path.dirname(planFilePath(plan)), { recursive: true });
    await fs.writeFile(planFilePath(plan), '# Legacy plan\n\nFirst real line.\n', 'utf8');
    await store.add(plan);

    const [summary] = await readReadySummaries(store);
    expect(summary?.fromFallback).toBe(true);
    expect(summary?.description).toContain('(no frontmatter — fallback excerpt)');
    expect(summary?.description).toContain('# Legacy plan');
    expect(summary?.description).toContain('First real line.');
  });
});
