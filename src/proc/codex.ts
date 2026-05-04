import { promises as fs } from 'node:fs';

import { type StreamSink, streamSubprocess } from './stream.js';

/**
 * Run `codex exec review -o <output> <prompt>`, streaming raw output to
 * `logPath` and parsed lines to the optional `sink`. After the process
 * exits, reads the codex `-o` output file (the structured review text) and
 * returns it. Returns "" if the file doesn't exist or is empty.
 *
 * Throws if codex exits non-zero.
 */
export async function runCodexReview(args: {
  prompt: string;
  outputPath: string;
  logPath: string;
  sink?: StreamSink;
}): Promise<{ code: number; reviewText: string }> {
  // Wipe any prior -o output so we don't read stale content if codex fails.
  await fs.rm(args.outputPath, { force: true });

  const cmd = ['codex', 'exec', 'review', '-o', args.outputPath, args.prompt];
  const sinkArg = args.sink ?? undefined;
  const code = await streamSubprocess({
    cmd,
    logPath: args.logPath,
    ...(sinkArg !== undefined ? { sink: sinkArg } : {}),
  });

  let reviewText = '';
  try {
    reviewText = await fs.readFile(args.outputPath, 'utf8');
  } catch (err: unknown) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
  return { code, reviewText };
}
