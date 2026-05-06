import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Write the current PID to `pidPath` so peer processes can signal this
 * daemon. The `tag` is recorded in the file and also assigned to
 * `process.title`, so a later `readLivePid` can confirm the PID still refers
 * to *this* daemon (and not an unrelated process that inherited a reused
 * PID after an unclean shutdown).
 *
 * Returns a cleanup that removes the file (only if it still contains our
 * PID — never clobber a successor's file).
 */
export async function writePidFile(pidPath: string, tag: string): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(pidPath), { recursive: true });
  process.title = tag;
  const ourPid = process.pid;
  await fs.writeFile(pidPath, `${ourPid}\n${tag}\n`, 'utf8');
  return async () => {
    try {
      const parsed = parsePidFile(await fs.readFile(pidPath, 'utf8'));
      if (parsed.pid === ourPid) {
        await fs.rm(pidPath, { force: true });
      }
    } catch {
      // ignore
    }
  };
}

function parsePidFile(raw: string): { pid: number | null; tag: string | null } {
  const [pidLine = '', tagLine = ''] = raw.split('\n');
  const pid = Number(pidLine.trim());
  const tag = tagLine.trim();
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    tag: tag.length > 0 ? tag : null,
  };
}

/**
 * Read the PID from `pidPath` and verify the process is alive *and* still
 * the daemon that wrote the file. Returns null if the file is missing,
 * malformed, the process is dead, or the running process's command line
 * doesn't contain the tag (i.e. the PID was reused). A reused-PID file is
 * removed as a side effect so future reads short-circuit.
 */
export async function readLivePid(pidPath: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await fs.readFile(pidPath, 'utf8');
  } catch {
    return null;
  }
  const { pid, tag } = parsePidFile(raw);
  if (pid === null) return null;
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  // Refuse to signal if we can't confirm identity (legacy file w/o tag, or
  // the tag doesn't appear in ps output). Drop the file so peers don't keep
  // hitting a stale entry.
  if (tag === null || !(await processMatchesTag(pid, tag))) {
    await removePidFileIfUnchanged(pidPath, raw);
    return null;
  }
  return pid;
}

async function removePidFileIfUnchanged(pidPath: string, expectedRaw: string): Promise<void> {
  try {
    const current = await fs.readFile(pidPath, 'utf8');
    if (current === expectedRaw) {
      await fs.rm(pidPath, { force: true });
    }
  } catch {
    // ignore
  }
}

async function processMatchesTag(pid: number, tag: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], {
      timeout: 2000,
    });
    return stdout.includes(tag);
  } catch {
    return false;
  }
}

export async function signalDaemon(pidPath: string, sig: NodeJS.Signals): Promise<boolean> {
  const pid = await readLivePid(pidPath);
  if (pid === null) return false;
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}
