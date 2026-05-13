import { spawn } from 'node:child_process';

/**
 * Best-effort user notification, used to surface pause/blocked states that
 * need human attention. All channels are independent and failures are
 * swallowed — a notification must never crash the caller.
 *
 * Channels:
 *   - stderr (default on): writes `${title}: ${message}\n` to stderr.
 *   - bell (default on): emits the terminal BEL (`\x07`) on stdout.
 *   - sound (default off, macOS only): plays a system .aiff via afplay.
 *   - desktop (default on, macOS only): posts a Notification Center message
 *     via osascript.
 *
 * Env vars:
 *   LAUREN_NO_NOTIFY=1 — silence everything sent through this helper.
 *   LAUREN_NO_SOUND=1  — silence sound + bell only (kept for backwards
 *                       compatibility with the original pause notification).
 */
export interface NotifyOptions {
  title: string;
  message: string;
  subtitle?: string;
  stderr?: boolean;
  bell?: boolean;
  sound?: boolean | string;
  desktop?: boolean;
}

const DEFAULT_SOUND = '/System/Library/Sounds/Glass.aiff';

export function notifyUser(opts: NotifyOptions): void {
  if (process.env.LAUREN_NO_NOTIFY === '1') return;
  const wantStderr = opts.stderr !== false;
  const wantBell = opts.bell !== false;
  const wantDesktop = opts.desktop !== false;
  const wantSound = opts.sound === true || typeof opts.sound === 'string';
  const silenced = process.env.LAUREN_NO_SOUND === '1';

  if (wantStderr) {
    try {
      process.stderr.write(`${opts.title}: ${opts.message}\n`);
    } catch {
      // stderr can be closed in some hosts (no-op).
    }
  }
  if (wantBell && !silenced) {
    try {
      process.stdout.write('\x07');
    } catch {
      // stdout can be closed in some hosts (no-op).
    }
  }
  if (wantSound && !silenced && process.platform === 'darwin') {
    const file = typeof opts.sound === 'string' ? opts.sound : DEFAULT_SOUND;
    spawnDetached('afplay', [file]);
  }
  if (wantDesktop && process.platform === 'darwin') {
    spawnDetached('osascript', ['-e', buildAppleScript(opts)]);
  }
}

function buildAppleScript(opts: NotifyOptions): string {
  const parts = [`display notification "${escapeForAppleScript(opts.message)}"`];
  parts.push(`with title "${escapeForAppleScript(opts.title)}"`);
  if (opts.subtitle) {
    parts.push(`subtitle "${escapeForAppleScript(opts.subtitle)}"`);
  }
  return parts.join(' ');
}

function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function spawnDetached(cmd: string, args: readonly string[]): void {
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      // Command missing or unable to spawn — ignore.
    });
    child.unref();
  } catch {
    // spawn itself can throw (e.g. EMFILE) — ignore.
  }
}
