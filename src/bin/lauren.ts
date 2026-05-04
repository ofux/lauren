#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';

import {
  applyOrganizeDecision,
  applyPlaceDecision,
  brainOrganizeQueue,
  brainPlacePlan,
  summarizeOrganizeDecision,
} from '../brain.js';
import {
  ARCH_PATH,
  DOCS_DIR,
  displayPath,
  LAUREN_DIR,
  PLANS_DIR,
  PRD_PATH,
  resolvePlanPath,
  TESTING_PATH,
} from '../core/paths.js';
import { validateSlug } from '../core/slug.js';
import { TodoStore } from '../core/store.js';
import { fmtAge, nowIso } from '../core/time.js';
import { type Plan, planFilePath, SlugCollision } from '../core/types.js';
import { PLAN_SYSTEM_PROMPT, SPEC_SYSTEM_PROMPT } from '../lauren-prompts.js';
import { runClaudeInteractive } from '../proc/claude.js';
import { confirm } from '../util/confirm.js';

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function cmdSpec(): Promise<number> {
  const candidates = [PRD_PATH, ARCH_PATH, TESTING_PATH];
  const existing: string[] = [];
  for (const c of candidates) {
    if (await fileExists(c)) existing.push(c);
  }
  if (existing.length > 0) {
    process.stdout.write('Existing docs detected:\n');
    for (const p of existing) {
      process.stdout.write(`  - ${displayPath(p)}\n`);
    }
    if (!(await confirm('Refine existing docs?'))) {
      process.stderr.write('aborted\n');
      return 1;
    }
  }
  await fs.mkdir(DOCS_DIR, { recursive: true });
  return runClaudeInteractive({
    systemPrompt: SPEC_SYSTEM_PROMPT,
    name: 'lauren spec',
    userPrompt: "I want to build something, let's write a little spec about it.",
  });
}

async function cmdPlan(seedPrompt?: string): Promise<number> {
  await fs.mkdir(PLANS_DIR, { recursive: true });
  await fs.mkdir(LAUREN_DIR, { recursive: true });

  const userPrompt = seedPrompt
    ? `Plan request: ${seedPrompt}\n\n` +
      `Follow your system prompt: explore, ask clarifying questions in batches, ` +
      `propose, iterate. When approved, write the plan to .lauren/plans/<slug>.md ` +
      `and register it via \`lauren _register ...\`.`
    : 'I want to plan a piece of work. Please ask me what to plan, ' +
      'then follow your system prompt to explore, propose, iterate, ' +
      'and finally write the plan to .lauren/plans/<slug>.md and register ' +
      'it via `lauren _register ...`.';

  const rc = runClaudeInteractive({
    systemPrompt: PLAN_SYSTEM_PROMPT,
    name: 'lauren plan',
    userPrompt,
  });

  // Orphan check.
  if (await fileExists(PLANS_DIR)) {
    const store = new TodoStore();
    const plans = await store.read();
    const registered = new Set(plans.map((p) => path.resolve(resolvePlanPath(p.path))));
    const entries = await fs.readdir(PLANS_DIR);
    const orphans: string[] = [];
    for (const name of entries.sort()) {
      if (!name.endsWith('.md')) continue;
      const full = path.resolve(PLANS_DIR, name);
      if (!registered.has(full)) orphans.push(full);
    }
    if (orphans.length > 0) {
      process.stdout.write('\nFound unregistered plan file(s):\n');
      for (const f of orphans) process.stdout.write(`  - ${displayPath(f)}\n`);
      process.stdout.write(
        'Register them via `lauren _register <slug> --path <path> ' +
          '--title "<title>"` or delete them.\n',
      );
    }
  }
  return rc;
}

async function cmdRegister(args: {
  slug: string;
  path: string;
  title: string;
  noBrain: boolean;
}): Promise<number> {
  validateSlug(args.slug);
  await fs.mkdir(LAUREN_DIR, { recursive: true });

  const store = new TodoStore();
  const plan: Plan = {
    slug: args.slug,
    title: args.title,
    path: args.path,
    status: 'pending',
    created_at: nowIso(),
    started_at: null,
    finished_at: null,
    failure: null,
  };

  try {
    await store.add(plan);
  } catch (err) {
    if (err instanceof SlugCollision) {
      process.stderr.write(
        `error: slug '${args.slug}' already in todo; pick a more specific name.\n`,
      );
      return 1;
    }
    throw err;
  }

  process.stdout.write(`queued '${args.slug}' — ${args.title}\n`);

  let body: string;
  try {
    body = await fs.readFile(planFilePath(plan), 'utf8');
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stdout.write(
        `warning: plan file ${plan.path} not found; left '${args.slug}' at end of queue.\n`,
      );
      return 0;
    }
    throw err;
  }

  if (args.noBrain) return 0;

  let decision: Awaited<ReturnType<typeof brainPlacePlan>>;
  try {
    decision = await brainPlacePlan(store, plan, body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `warning: brain unavailable (${msg}); left '${args.slug}' at end of queue.\n`,
    );
    return 0;
  }

  const summary = await applyPlaceDecision(store, plan, decision);
  process.stdout.write(`brain: ${summary}\n`);
  return 0;
}

async function cmdOrganize(opts: { yes: boolean }): Promise<number> {
  await fs.mkdir(LAUREN_DIR, { recursive: true });
  const store = new TodoStore();
  const pending = (await store.read()).filter((p) => p.status === 'pending');
  if (pending.length < 2) {
    process.stdout.write(
      `only ${pending.length} pending plan(s); nothing for the brain to organize.\n`,
    );
    return 0;
  }

  process.stdout.write(`asking brain to organize ${pending.length} pending plan(s)…\n`);
  let decision: Awaited<ReturnType<typeof brainOrganizeQueue>>['decision'];
  try {
    ({ decision } = await brainOrganizeQueue(store));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: brain failed: ${msg}\n`);
    return 1;
  }

  const reasoning = typeof decision.reasoning === 'string' ? decision.reasoning.trim() : '';
  process.stdout.write('\nbrain proposes:\n');
  for (const line of summarizeOrganizeDecision(decision)) {
    process.stdout.write(`  ${line}\n`);
  }
  if (reasoning) process.stdout.write(`reasoning: ${reasoning}\n`);

  const ops = decision.operations ?? [];
  if (ops.length === 0) return 0;

  if (!opts.yes && !(await confirm('\nApply these operations?'))) {
    process.stdout.write('aborted; queue unchanged.\n');
    return 0;
  }

  process.stdout.write('\n');
  for (const line of await applyOrganizeDecision(store, decision)) {
    process.stdout.write(`${line}\n`);
  }
  return 0;
}

async function cmdTodoList(): Promise<number> {
  const store = new TodoStore();
  const plans = await store.read();
  if (plans.length === 0) {
    process.stdout.write('(empty queue)\n');
    return 0;
  }
  printTable(plans);
  return 0;
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';

function statusCell(status: Plan['status']): { plain: string; rendered: string } {
  switch (status) {
    case 'failed':
      return { plain: 'failed', rendered: `${BOLD}${RED}failed${RESET}` };
    case 'in_progress':
      return { plain: 'in_progress', rendered: `${BOLD}${CYAN}in_progress${RESET}` };
    case 'done':
      return { plain: 'done', rendered: `${GREEN}done${RESET}` };
    default:
      return { plain: 'pending', rendered: `${DIM}pending${RESET}` };
  }
}

function pad(s: string, width: number, align: 'left' | 'right'): string {
  if (s.length >= width) return s;
  const filler = ' '.repeat(width - s.length);
  return align === 'right' ? filler + s : s + filler;
}

function printTable(plans: Plan[]): void {
  const headers = ['#', 'status', 'slug', 'title', 'age'];
  const rows = plans.map((p, i) => {
    const s = statusCell(p.status);
    return {
      idx: String(i + 1),
      status: s,
      slug: p.slug,
      title: p.title,
      age: fmtAge(p.created_at),
    };
  });
  const widths = {
    idx: Math.max(headers[0]!.length, 3, ...rows.map((r) => r.idx.length)),
    status: Math.max(headers[1]!.length, 12, ...rows.map((r) => r.status.plain.length)),
    slug: Math.max(headers[2]!.length, ...rows.map((r) => r.slug.length)),
    title: Math.max(headers[3]!.length, ...rows.map((r) => r.title.length)),
    age: Math.max(headers[4]!.length, 6, ...rows.map((r) => r.age.length)),
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

  for (const r of rows) {
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

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('lauren')
    .description(
      'Queue-driven plan/vibe lifecycle runner — brain side (planning + queue management).',
    )
    .version('0.1.0');

  program
    .command('spec')
    .description('interview the user and write docs/PRD.md, ARCHITECTURE.md, TESTING.md (optional)')
    .action(async () => {
      process.exit(await cmdSpec());
    });

  program
    .command('plan')
    .description('produce a plan at .lauren/plans/<slug>.md and queue it (brain decides placement)')
    .argument('[seed_prompt]', 'optional seed message for the planner')
    .action(async (seedPrompt?: string) => {
      process.exit(await cmdPlan(seedPrompt));
    });

  program
    .command('organize')
    .description('re-think the pending queue with the AI brain (may reorder and merge)')
    .option('-y, --yes', 'apply without asking for confirmation', false)
    .action(async (opts: { yes: boolean }) => {
      process.exit(await cmdOrganize({ yes: opts.yes }));
    });

  const todo = program.command('todo').description('read-only queue commands');
  todo
    .command('list')
    .description('list queued plans')
    .action(async () => {
      process.exit(await cmdTodoList());
    });

  program
    .command('_register', { hidden: true })
    .argument('<slug>')
    .requiredOption('--path <path>', 'path to the plan .md file')
    .requiredOption('--title <title>', 'display title for the plan')
    .option('--no-brain', 'skip brain placement (append to end of queue)', false)
    .action(async (slug: string, opts: { path: string; title: string; brain: boolean }) => {
      // Commander's --no-brain inverts: opts.brain === false when --no-brain set.
      process.exit(
        await cmdRegister({
          slug,
          path: opts.path,
          title: opts.title,
          noBrain: opts.brain === false,
        }),
      );
    });

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
