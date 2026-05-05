import { describe, expect, test } from 'vitest';
import { isValidSlug, SLUG_RE } from './slug.js';

describe('isValidSlug', () => {
  test('accepts lowercase kebab-case', () => {
    expect(isValidSlug('foo-bar')).toBe(true);
    expect(isValidSlug('a1')).toBe(true);
  });

  test('rejects uppercase', () => {
    expect(isValidSlug('Foo')).toBe(false);
  });

  test('rejects leading dash and single-character slugs', () => {
    expect(isValidSlug('-foo')).toBe(false);
    expect(isValidSlug('a')).toBe(false);
  });

  test('rejects empty string and special characters', () => {
    expect(isValidSlug('')).toBe(false);
    expect(isValidSlug('foo_bar')).toBe(false);
    expect(isValidSlug('foo bar')).toBe(false);
  });

  test('respects the length boundary (2–49 chars)', () => {
    expect(isValidSlug('a'.repeat(49))).toBe(true);
    expect(isValidSlug('a'.repeat(50))).toBe(false);
  });

  test('SLUG_RE source is the documented pattern', () => {
    expect(SLUG_RE.source).toBe('^[a-z0-9][a-z0-9-]{1,48}$');
  });
});
