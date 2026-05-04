/**
 * Convert one line from `claude -p --output-format stream-json --verbose`
 * into 0+ short, human-readable display lines for the TUI tail. Unknown or
 * noisy events return []; non-JSON lines pass through unchanged.
 */
export function formatClaudeStreamLine(line: string): string[] {
  const s = line.trim();
  if (!s) return [];
  let ev: unknown;
  try {
    ev = JSON.parse(s);
  } catch {
    return [s];
  }
  if (typeof ev !== 'object' || ev === null) return [];
  const e = ev as Record<string, unknown>;
  const t = e.type;

  if (t === 'system' && e.subtype === 'init') {
    const model = typeof e.model === 'string' ? e.model : '';
    const out = `session started · ${model}`.replace(/\s*·\s*$/, '');
    return [out];
  }
  if (t === 'assistant') {
    const msg = (e.message as Record<string, unknown> | undefined) ?? {};
    const content = (msg.content as unknown[] | undefined) ?? [];
    const out: string[] = [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      const btype = b.type;
      if (btype === 'text') {
        const text = typeof b.text === 'string' ? b.text.trim() : '';
        if (text) {
          const firstLine = text.split('\n')[0] ?? '';
          out.push(firstLine);
        }
      } else if (btype === 'tool_use') {
        const name = typeof b.name === 'string' ? b.name : '?';
        const input = (b.input as Record<string, unknown> | undefined) ?? {};
        const keys = [
          'file_path',
          'command',
          'path',
          'pattern',
          'description',
          'url',
          'query',
          'prompt',
        ];
        let preview = '';
        for (const k of keys) {
          const v = input[k];
          if (typeof v === 'string' && v) {
            preview = v.split('\n')[0] ?? '';
            break;
          }
        }
        out.push(preview ? `→ ${name}(${preview})` : `→ ${name}`);
      }
    }
    return out;
  }
  if (t === 'result') {
    if (e.is_error) {
      const result = typeof e.result === 'string' ? e.result : '';
      return [`✗ error: ${result.slice(0, 120)}`];
    }
    const cost = e.total_cost_usd;
    if (typeof cost === 'number') return [`✓ done · $${cost.toFixed(4)}`];
    return ['✓ done'];
  }
  return [];
}

/**
 * Parse the full stdout of `claude -p --output-format stream-json --verbose`
 * and return the final result string from the `{type: "result"}` event.
 * Throws on errors. Empty result returns "".
 */
export function parseClaudeOneshotResult(stdout: string): string {
  let final = '';
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof ev !== 'object' || ev === null) continue;
    const e = ev as Record<string, unknown>;
    if (e.type === 'result') {
      if (e.is_error) {
        const result = typeof e.result === 'string' ? e.result : String(e.result ?? '');
        throw new Error(`claude returned error: ${result.slice(0, 400)}`);
      }
      final = typeof e.result === 'string' ? e.result : '';
    }
  }
  return final;
}
