import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { REPO } from '../core/paths.js';

export interface StreamSink {
  /** Receive one display-formatted line for the live TUI. */
  appendLog(line: string): void;
}

export interface StreamSubprocessOptions {
  cmd: string[];
  logPath: string;
  sink?: StreamSink;
  /**
   * Optional transformer: raw line in, 0+ display lines out. Raw lines still
   * land in the log file verbatim.
   */
  transformer?: (line: string) => string[];
  cwd?: string;
  /**
   * If aborted while the child is running, the child is sent SIGTERM. The
   * function still resolves with the resulting exit code (typically non-zero).
   */
  signal?: AbortSignal;
}

/**
 * Spawn a process, capture stdout *and* stderr line-by-line into the log file
 * (with header/footer), and either feed display lines to `sink` or to
 * process.stdout. Returns the exit code (or 1 if the process was killed by
 * signal without an exit code).
 */
export async function streamSubprocess(opts: StreamSubprocessOptions): Promise<number> {
  const { cmd, logPath, sink, transformer, signal } = opts;
  const cwd = opts.cwd ?? REPO;

  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const fh = await fs.open(logPath, 'w');
  try {
    const startedAt = new Date().toISOString();
    // JSON.stringify keeps arg boundaries when args contain spaces or quotes.
    const cmdRendered = cmd.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
    await fh.write(`# ${cmdRendered}\n# started: ${startedAt}\n\n`);

    const [program, ...args] = cmd;
    if (!program) {
      throw new Error('streamSubprocess: empty command');
    }

    const child = spawn(program, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(signal !== undefined ? { signal } : {}),
    });

    // Serialize all writes through a single chain — both stdout and stderr
    // readlines feed into this so log + display ordering stays consistent.
    let writeChain: Promise<void> = Promise.resolve();
    const enqueue = (raw: string): Promise<void> => {
      writeChain = writeChain.then(async () => {
        await fh.write(raw.endsWith('\n') ? raw : `${raw}\n`);
        const display = transformer ? transformer(raw) : [raw];
        for (const dline of display) {
          if (sink) {
            sink.appendLog(dline);
          } else {
            process.stdout.write(dline.endsWith('\n') ? dline : `${dline}\n`);
          }
        }
      });
      return writeChain;
    };

    const readers = [child.stdout, child.stderr].map((stream) => {
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      return (async () => {
        for await (const line of rl) {
          await enqueue(line);
        }
      })();
    });

    const code = await new Promise<number>((resolve) => {
      child.on('close', (c) => resolve(c ?? 1));
      child.on('error', () => resolve(1));
    });
    await Promise.all(readers);
    await writeChain;

    await fh.write(`\n# exit: ${code}\n`);
    return code;
  } finally {
    await fh.close().catch(() => undefined);
  }
}
