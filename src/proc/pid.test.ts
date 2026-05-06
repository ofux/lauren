import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { execFileAsyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  Object.assign(execFile, {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsyncMock,
  });
  return { execFile };
});

import { readLivePid } from './pid.js';

describe('PID helpers', () => {
  let tmpDir: string;
  let pidPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lauren-pid-'));
    pidPath = path.join(tmpDir, 'daemon.pid');
    execFileAsyncMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('removes unchanged stale PID files after identity mismatch', async () => {
    await fs.writeFile(pidPath, `${process.pid}\nwrong-daemon\n`, 'utf8');
    execFileAsyncMock.mockResolvedValue({ stdout: 'unrelated command\n', stderr: '' });

    await expect(readLivePid(pidPath)).resolves.toBeNull();
    await expect(fs.access(pidPath)).rejects.toThrow();
  });

  test('does not remove a successor PID file after identity mismatch', async () => {
    const successorRaw = `${process.pid}\nlauren-vibe\n`;
    await fs.writeFile(pidPath, `${process.pid}\nwrong-daemon\n`, 'utf8');
    execFileAsyncMock.mockImplementation(async () => {
      await fs.writeFile(pidPath, successorRaw, 'utf8');
      return { stdout: 'unrelated command\n', stderr: '' };
    });

    await expect(readLivePid(pidPath)).resolves.toBeNull();
    await expect(fs.readFile(pidPath, 'utf8')).resolves.toBe(successorRaw);
  });
});
