import { describe, expect, test } from 'vitest';
import { stripAnsi } from './ansi.js';

describe('stripAnsi', () => {
  test('removes ANSI color escape sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(stripAnsi('\x1b[1;33mbold yellow\x1b[m')).toBe('bold yellow');
  });

  test('is a no-op on plain text', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});
