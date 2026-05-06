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
  resolveRepoRoot,
} from './paths.js';

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
  const context: LaurenContext = {
    repo: path.join(path.sep, 'tmp', 'lauren-context-repo'),
    laurenDir: path.join(path.sep, 'tmp', 'lauren-context-repo', '.lauren'),
    logRoot: path.join(path.sep, 'tmp', 'lauren-context-repo', '.lauren', 'logs'),
    plansDir: path.join(path.sep, 'tmp', 'lauren-context-repo', '.lauren', 'plans'),
    todoPath: path.join(path.sep, 'tmp', 'lauren-context-repo', '.lauren', 'todo.json'),
    lockPath: path.join(path.sep, 'tmp', 'lauren-context-repo', '.lauren', 'todo.json.lock'),
    vibeLockPath: path.join(path.sep, 'tmp', 'lauren-context-repo', '.lauren', 'vibe.lock'),
    docsDir: path.join(path.sep, 'tmp', 'lauren-context-repo', 'docs'),
    prdPath: path.join(path.sep, 'tmp', 'lauren-context-repo', 'docs', 'PRD.md'),
    archPath: path.join(path.sep, 'tmp', 'lauren-context-repo', 'docs', 'ARCHITECTURE.md'),
    testingPath: path.join(path.sep, 'tmp', 'lauren-context-repo', 'docs', 'TESTING.md'),
  };

  test('path helpers can use an injected context', () => {
    expect(displayPath(path.join(context.plansDir, 'demo.md'), context)).toBe(
      path.join('.lauren', 'plans', 'demo.md'),
    );
    expect(normalizePlanPath(path.join(context.plansDir, 'demo.md'), context)).toBe(
      path.join('.lauren', 'plans', 'demo.md'),
    );
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
