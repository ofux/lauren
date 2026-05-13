import { spawn } from 'node:child_process';

/**
 * Open a local file or URL in the user's default browser. Cross-platform:
 * `open` on macOS, `start` on Windows, `xdg-open` elsewhere. Spawns
 * detached + stdio ignored + `.unref()`d so the launcher process exits
 * immediately whether or not the browser successfully takes over.
 *
 * Failures are swallowed: returning a status would force the caller to
 * surface a UI error for something the user can easily detect themselves
 * (the browser didn't appear). The function is best-effort.
 */
export function openInBrowser(target: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', target] : [target];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      // launcher missing or failed — nothing to do
    });
    child.unref();
  } catch {
    // spawn itself can throw (EMFILE etc) — ignore
  }
}
