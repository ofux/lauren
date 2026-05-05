import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { displayPath, REPO, resolvePlanPath } from './paths.js';

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

describe('resolvePlanPath', () => {
  test('joins relative paths with REPO', () => {
    expect(resolvePlanPath('.lauren/plans/demo.md')).toBe(path.join(REPO, '.lauren/plans/demo.md'));
  });

  test('returns absolute paths unchanged (after resolve)', () => {
    const absolute = path.resolve('/tmp', 'demo.md');
    expect(resolvePlanPath(absolute)).toBe(absolute);
  });
});
