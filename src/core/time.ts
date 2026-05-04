export function nowIso(): string {
  // Match Python's `datetime.now(tz=UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")`
  // → e.g. "2026-05-08T12:14:33Z"
  const d = new Date();
  d.setMilliseconds(0);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function monotonicSeconds(): number {
  return performance.now() / 1000;
}

export function fmtDuration(seconds: number): string {
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const totalSec = Math.floor(seconds);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${String(mm).padStart(2, '0')}m`;
}

export function fmtAge(iso: string): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

export function spinnerFrame(): string {
  const idx = Math.floor((performance.now() / 1000) * 10) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES.charAt(idx);
}
