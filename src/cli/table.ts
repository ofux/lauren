import { fmtAge } from '../core/time.js';
import type { Plan, PlanStatus } from '../core/types.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';

export interface UnifiedRow {
  plan: Plan;
  store: 'inbox' | 'todo';
}

function statusCell(status: PlanStatus): { plain: string; rendered: string } {
  switch (status) {
    case 'failed':
      return { plain: 'failed', rendered: `${BOLD}${RED}failed${RESET}` };
    case 'implementing':
      return { plain: 'implementing', rendered: `${BOLD}${CYAN}implementing${RESET}` };
    case 'preparing':
      return { plain: 'preparing', rendered: `${BOLD}${MAGENTA}preparing${RESET}` };
    case 'enqueued':
      return { plain: 'enqueued', rendered: `${YELLOW}enqueued${RESET}` };
    case 'ready':
      return { plain: 'ready', rendered: `${GREEN}ready${RESET}` };
    case 'done':
      return { plain: 'done', rendered: `${DIM}${GREEN}done${RESET}` };
    case 'cancelled':
      return { plain: 'cancelled', rendered: `${DIM}cancelled${RESET}` };
    default:
      return { plain: status, rendered: `${DIM}${status}${RESET}` };
  }
}

function pad(s: string, width: number, align: 'left' | 'right'): string {
  if (s.length >= width) return s;
  const filler = ' '.repeat(width - s.length);
  return align === 'right' ? filler + s : s + filler;
}

export function printTodoTable(rows: UnifiedRow[]): void {
  const headers = ['#', 'status', 'slug', 'title', 'age'];
  const tableRows = rows.map(({ plan }, i) => {
    const s = statusCell(plan.status);
    return {
      idx: String(i + 1),
      status: s,
      slug: plan.slug,
      title: plan.title,
      age: fmtAge(plan.created_at),
    };
  });
  const widths = {
    idx: Math.max(headers[0]!.length, 3, ...tableRows.map((r) => r.idx.length)),
    status: Math.max(headers[1]!.length, 12, ...tableRows.map((r) => r.status.plain.length)),
    slug: Math.max(headers[2]!.length, ...tableRows.map((r) => r.slug.length)),
    title: Math.max(headers[3]!.length, ...tableRows.map((r) => r.title.length)),
    age: Math.max(headers[4]!.length, 6, ...tableRows.map((r) => r.age.length)),
  };

  const headerLine =
    `${BOLD}${pad(headers[0]!, widths.idx, 'right')}${RESET}` +
    '  ' +
    `${BOLD}${pad(headers[1]!, widths.status, 'left')}${RESET}` +
    '  ' +
    `${BOLD}${pad(headers[2]!, widths.slug, 'left')}${RESET}` +
    '  ' +
    `${BOLD}${pad(headers[3]!, widths.title, 'left')}${RESET}` +
    '  ' +
    `${BOLD}${pad(headers[4]!, widths.age, 'right')}${RESET}`;
  process.stdout.write(`${headerLine}\n`);

  for (const r of tableRows) {
    const statusPadded = r.status.plain.padEnd(widths.status, ' ');
    const statusRendered = r.status.rendered + statusPadded.slice(r.status.plain.length);
    process.stdout.write(
      `${DIM}${pad(r.idx, widths.idx, 'right')}${RESET}  ` +
        `${statusRendered}  ` +
        `${BOLD}${pad(r.slug, widths.slug, 'left')}${RESET}  ` +
        `${pad(r.title, widths.title, 'left')}  ` +
        `${DIM}${pad(r.age, widths.age, 'right')}${RESET}\n`,
    );
  }
}
