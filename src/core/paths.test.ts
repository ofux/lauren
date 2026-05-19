import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  assertPlanPathInsideLaurenPlans,
  displayPath,
  type LaurenContext,
  normalizePlanPath,
  PLANS_DIR,
  REPO,
  resolvePlanPath,
  resolvePlanSidecarPath,
  resolveRepoRoot,
} from './paths.js';
import { type Plan, planNotesPath } from './types.js';

describe('displayPath', () => {
  test('strips a REPO prefix and returns the relative path', () => {
    expect(displayPath(path.join(REPO, '.lauren', 'plans', 'demo.md'))).toBe(
      path.join('.lauren', 'plans', 'demo.md'),
    );
  });

  test('returns absolute paths outside REPO unchanged', () => {
    const outside = path.resolve('/tmp', 'somewhere-not-under-repo');
    expect(displayPath(outside)).toBe(outside);
  });
});

describe('LaurenContext', () => {
  const root = path.join(path.sep, 'tmp', 'lauren-context-repo');
  const laurenDir = path.join(root, '.lauren');
  const docsDir = path.join(root, 'docs');
  const context: LaurenContext = {
    repo: root,
    laurenDir,
    logRoot: path.join(laurenDir, 'logs'),
    plansDir: path.join(laurenDir, 'plans'),
    notesDir: path.join(laurenDir, 'notes'),
    worktreesRoot: path.join(laurenDir, 'worktrees'),
    configPath: path.join(laurenDir, 'config.json'),
    plansStatePath: path.join(laurenDir, 'plans.json'),
    plansStateLockPath: path.join(laurenDir, 'plans.json.lock'),
    vibeLockPath: path.join(laurenDir, 'vibe.lock'),
    vibePidPath: path.join(laurenDir, 'vibe.pid'),
    docsDir,
    prdPath: path.join(docsDir, 'PRD.md'),
    archPath: path.join(docsDir, 'ARCHITECTURE.md'),
    testingPath: path.join(docsDir, 'TESTING.md'),
  };

  test('path helpers can use an injected context', () => {
    expect(displayPath(path.join(context.plansDir, 'demo.md'), context)).toBe(
      path.join('.lauren', 'plans', 'demo.md'),
    );
    expect(normalizePlanPath(path.join(context.plansDir, 'demo.md'), context)).toBe(
      path.join('.lauren', 'plans', 'demo.md'),
    );
  });

  test('planNotesPath resolves under notesDir keyed by slug', () => {
    const plan = { slug: 'demo' } as unknown as Plan;
    expect(planNotesPath(plan, context)).toBe(path.join(context.notesDir, 'demo.notes.html'));
  });
});

describe('resolvePlanPath', () => {
  test('joins relative paths with REPO', () => {
    expect(resolvePlanPath('.lauren/plans/demo.md')).toBe(path.join(REPO, '.lauren/plans/demo.md'));
  });

  test('returns absolute paths unchanged (after resolve)', () => {
    const absolute = path.resolve('/tmp', 'demo.md');
    expect(resolvePlanPath(absolute)).toBe(absolute);
  });
});

describe('plan path validation', () => {
  test('normalizes absolute plan paths under .lauren/plans to repo-relative paths', () => {
    expect(normalizePlanPath(path.join(PLANS_DIR, 'demo.md'))).toBe(
      path.join('.lauren', 'plans', 'demo.md'),
    );
  });

  test('accepts relative markdown paths under .lauren/plans', () => {
    expect(assertPlanPathInsideLaurenPlans('.lauren/plans/demo.md')).toBe(
      path.join(PLANS_DIR, 'demo.md'),
    );
  });

  test('rejects paths outside .lauren/plans', () => {
    expect(() => normalizePlanPath('docs/demo.md')).toThrow(/under \.lauren\/plans/);
    expect(() => normalizePlanPath(path.join(REPO, 'outside.md'))).toThrow(/under \.lauren\/plans/);
  });

  test('rejects non-markdown files inside .lauren/plans', () => {
    expect(() => normalizePlanPath('.lauren/plans/demo.txt')).toThrow(/\.md file/);
  });
});

describe('resolvePlanSidecarPath', () => {
  test('resolves sidecars next to the plan file', () => {
    expect(resolvePlanSidecarPath('./demo.cp1.html', '.lauren/plans/demo.md')).toBe(
      path.join(PLANS_DIR, 'demo.cp1.html'),
    );
  });

  test('rejects checkpoint sidecars outside the plan directory', () => {
    expect(() => resolvePlanSidecarPath('../outside.html', '.lauren/plans/demo.md')).toThrow(
      /sidecar path must be next to/,
    );
    expect(() =>
      resolvePlanSidecarPath(path.join(REPO, 'docs', 'outside.html'), '.lauren/plans/demo.md'),
    ).toThrow(/sidecar path must be next to/);
  });
});

describe('resolveRepoRoot', () => {
  test('returns the git top-level when cwd is a subdirectory', () => {
    const nested = path.join(REPO, 'src', 'core');
    expect(resolveRepoRoot(nested)).toBe(REPO);
  });

  test('falls back to the provided cwd outside a git repository', () => {
    const outside = path.join(path.sep, 'tmp');
    let expected = path.resolve(outside);
    try {
      expected = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: outside,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // /tmp is normally not a git repository. If it is, the branch above keeps the test honest.
    }
    expect(resolveRepoRoot(outside)).toBe(path.resolve(expected));
  });
});
