import { spawn } from 'node:child_process';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { openInBrowser } from './openInBrowser.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    on: vi.fn(),
    unref: vi.fn(),
  })),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openInBrowser', () => {
  test('uses cmd.exe for the Windows start shell builtin', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    openInBrowser('C:\\tmp\\checkpoint.html');

    expect(spawn).toHaveBeenCalledWith('cmd', ['/c', 'start', '', 'C:\\tmp\\checkpoint.html'], {
      stdio: 'ignore',
      detached: true,
    });
  });
});
