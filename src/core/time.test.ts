import { describe, expect, test } from 'vitest';
import { fmtAge, fmtDuration, nowIso, SPINNER_FRAMES, spinnerFrame } from './time.js';

describe('fmtDuration', () => {
  test('formats sub-10-second values with one decimal place', () => {
    expect(fmtDuration(0)).toBe('0.0s');
    expect(fmtDuration(5.5)).toBe('5.5s');
  });

  test('formats sub-minute values as rounded whole seconds', () => {
    expect(fmtDuration(10)).toBe('10s');
    expect(fmtDuration(59)).toBe('59s');
  });

  test('formats minute values with zero-padded seconds', () => {
    expect(fmtDuration(60)).toBe('1m 00s');
    expect(fmtDuration(125)).toBe('2m 05s');
  });

  test('formats hour values with zero-padded minutes', () => {
    expect(fmtDuration(3600)).toBe('1h 00m');
    expect(fmtDuration(3725)).toBe('1h 02m');
  });
});

describe('fmtAge', () => {
  test('returns an empty string for empty or unparseable input', () => {
    expect(fmtAge('')).toBe('');
    expect(fmtAge('not a date')).toBe('');
  });

  test('formats sub-minute ages in seconds', () => {
    const iso = new Date(Date.now() - 30_000).toISOString();
    expect(fmtAge(iso)).toMatch(/^\d{1,2}s$/);
  });

  test('formats minute, hour, and day boundaries', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const twoHrAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    const threeDaysAgo = new Date(Date.now() - 3 * 86400_000).toISOString();
    expect(fmtAge(fiveMinAgo)).toBe('5m');
    expect(fmtAge(twoHrAgo)).toBe('2h');
    expect(fmtAge(threeDaysAgo)).toBe('3d');
  });
});

describe('spinnerFrame', () => {
  test('returns one of the spinner frames', () => {
    expect(SPINNER_FRAMES).toContain(spinnerFrame());
  });
});

describe('nowIso', () => {
  test('returns an ISO-8601 UTC string with second precision (no millis)', () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
