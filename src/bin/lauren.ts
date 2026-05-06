#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';

import {
  applyOrganizeDecision,
  applyPlaceDecision,
  brainOrganizeQueue,
  brainPlacePlan,
  summarizeOrganizeDecision,
} from '../brain.js';
import { printTodoTable, type UnifiedRow } from '../cli/table.js';
import { InboxStore } from '../core/inbox.js';
import {
  ARCH_PATH,
  BRAIN_LOCK_PATH,
  BRAIN_PID_PATH,
  DOCS_DIR,
  displayPath,
  LAUREN_DIR,
  normalizePlanPath,
  PLANS_DIR,
  PRD_PATH,
  resolvePlanPath,
  TESTING_PATH,
} from '../core/paths.js';
import { validateSlug } from '../core/slug.js';
import { TodoStore } from '../core/store.js';
import { nowIso } from '../core/time.js';
import { type Plan, PlanNotFound, planFilePath, SlugCollision } from '../core/types.js';
import { formatRepoList, resolveWorkspaceRepos, WorkspaceConfigError } from '../core/workspace.js';
import { PLAN_SYSTEM_PROMPT, SPEC_SYSTEM_PROMPT } from '../lauren-prompts.js';
import { ClaudeAborted, runClaudeInteractive } from '../proc/claude.js';
import { slugHasLaurenHistory } from '../proc/git.js';
import { writePidFile } from '../proc/pid.js';
import { TodoApp } from '../tui/TodoApp.js';
import { confirm } from '../util/confirm.js';
import { configureVibeCommand } from '../vibe-command.js';
import { tryAcquireBrainLock } from '../watcher.js';

const BRAIN_IDLE_POLL_MS = 3000;

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
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

  // Orphan check — a plan is "registered" if it lives in the todo store
  // (already placed) or in the inbox (awaiting brain placement).
  if (await fileExists(PLANS_DIR)) {
    const store = new TodoStore();
    const inboxStore = new InboxStore();
    const allPlans = [...(await store.read()), ...(await inboxStore.read())];
    const registered = new Set(allPlans.map((p) => path.resolve(resolvePlanPath(p.path))));
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
  repos: string[];
}): Promise<number> {
  validateSlug(args.slug);
  let targetRepos: Awaited<ReturnType<typeof resolveWorkspaceRepos>>;
  try {
    targetRepos = await resolveWorkspaceRepos(args.repos);
  } catch (err) {
    if (err instanceof WorkspaceConfigError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const existingHistoryRepo = targetRepos.find((repo) =>
    slugHasLaurenHistory(args.slug, repo.root),
  );
  if (existingHistoryRepo) {
    process.stderr.write(
      `error: slug '${args.slug}' already has Lauren commit history in ` +
        `${existingHistoryRepo.name}; ` +
        `pick a more specific name so resume detection cannot skip old work.\n`,
    );
    return 1;
  }
  const normalizedPath = normalizePlanPath(args.path);
  await fs.mkdir(LAUREN_DIR, { recursive: true });

  const plan: Plan = {
    slug: args.slug,
    title: args.title,
    path: normalizedPath,
    target_repos: args.repos.length === 0 ? [] : targetRepos.map((repo) => repo.name),
    status: 'enqueued',
    cancel_requested: false,
    created_at: nowIso(),
    started_at: null,
    finished_at: null,
    failure: null,
  };

  // Existence check — body is unused here; the brain daemon re-reads it later.
  try {
    await fs.access(planFilePath(plan));
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stderr.write(`error: plan file not found: ${plan.path}\n`);
      return 1;
    }
    throw err;
  }

  // Cross-store collision: refuse if slug already exists in either inbox or todo.
  const todoStore = new TodoStore();
  const inboxStore = new InboxStore();
  if ((await todoStore.find(args.slug)) !== null) {
    process.stderr.write(
      `error: slug '${args.slug}' already in todo; pick a more specific name.\n`,
    );
    return 1;
  }

  try {
    await inboxStore.add(plan);
  } catch (err) {
    if (err instanceof SlugCollision) {
      process.stderr.write(
        `error: slug '${args.slug}' already in inbox; pick a more specific name.\n`,
      );
      return 1;
    }
    throw err;
  }

  process.stdout.write(
    `queued '${args.slug}' as enqueued — ${args.title}\n` +
      `target repo(s): ${formatRepoList(targetRepos)}\n` +
      `(run \`lauren organize\` to let the AI place it into the todo queue.)\n`,
  );
  return 0;
}

async function cmdOrganizeAll(opts: { yes: boolean; dryRun: boolean }): Promise<number> {
  await fs.mkdir(LAUREN_DIR, { recursive: true });
  const store = new TodoStore();
  const ready = (await store.read()).filter((p) => p.status === 'ready');
  if (ready.length < 2) {
    process.stdout.write(
      `only ${ready.length} ready plan(s); nothing for the brain to organize.\n`,
    );
    return 0;
  }

  process.stdout.write(`asking brain to organize ${ready.length} ready plan(s)…\n`);
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

  if (opts.dryRun) {
    process.stdout.write('\n[dry-run] no mutations applied.\n');
    return 0;
  }

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

function unifiedRows(inboxPlans: Plan[], todoPlans: Plan[]): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  for (const p of inboxPlans) rows.push({ plan: p, store: 'inbox' });
  for (const p of todoPlans) rows.push({ plan: p, store: 'todo' });
  return rows;
}

async function cmdTodoList(): Promise<number> {
  const todoStore = new TodoStore();
  const inboxStore = new InboxStore();
  const [todoPlans, inboxPlans] = await Promise.all([todoStore.read(), inboxStore.read()]);
  const rows = unifiedRows(inboxPlans, todoPlans);
  if (rows.length === 0) {
    process.stdout.write('(empty queue)\n');
    return 0;
  }
  printTodoTable(rows);
  return 0;
}

async function cmdTodoTui(): Promise<number> {
  // Non-TTY (pipe, redirected output, CI): print a static table and exit.
  if (!process.stdout.isTTY) {
    return cmdTodoList();
  }

  const todoStore = new TodoStore();
  const inboxStore = new InboxStore();

  const inkApp = render(React.createElement(TodoApp, { todoStore, inboxStore }), {
    exitOnCtrlC: true,
  });

  await inkApp.waitUntilExit();
  return 0;
}

function sleepMs(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function describePlaceDecision(
  decision: Awaited<ReturnType<typeof brainPlacePlan>>,
  newPlan: Plan,
): string {
  if (decision.kind === 'merge') {
    return (
      `merge '${newPlan.slug}' into '${decision.targetSlug}'` +
      ` (new title: ${JSON.stringify(decision.mergedTitle)})` +
      `${decision.reasoning ? ` — ${decision.reasoning}` : ''}`
    );
  }
  if (decision.kind === 'insert') {
    return (
      `insert '${newPlan.slug}' at position ${decision.position}` +
      `${decision.reasoning ? ` — ${decision.reasoning}` : ''}`
    );
  }
  return `invalid decision: ${decision.message}`;
}

interface BrainCancelState {
  current: string | null;
  controller: AbortController | null;
}

/**
 * Process one inbox plan: place it into the todo via the brain, then drop
 * it from the inbox. Idempotent — handles the case where a previous run
 * crashed between todoStore.add and inboxStore.remove.
 *
 * If the inbox plan has cancel_requested=true at the start, the plan is
 * removed from the inbox and skipped. While brain placement is running,
 * the AbortSignal in `state.controller` may abort the claude subprocess
 * (raised when the TUI signals SIGUSR2 mid-flight).
 */
async function processInboxPlan(args: {
  plan: Plan;
  todoStore: TodoStore;
  inboxStore: InboxStore;
  dryRun: boolean;
  state: BrainCancelState;
}): Promise<void> {
  const { plan, todoStore, inboxStore, dryRun, state } = args;

  // Crash-recovery shortcut: if the plan is already in todo, a previous
  // iteration placed it but failed to clean up the inbox. Just remove it.
  const existing = await todoStore.find(plan.slug);
  if (existing !== null) {
    if (dryRun) {
      process.stdout.write(
        `[dry-run] '${plan.slug}' already in todo (status=${existing.status}); ` +
          `would just remove from inbox.\n`,
      );
      return;
    }
    process.stdout.write(
      `'${plan.slug}' already in todo (status=${existing.status}); removing from inbox.\n`,
    );
    await inboxStore.remove(plan.slug, { allowPreparing: true }).catch((err) => {
      if (!(err instanceof PlanNotFound)) throw err;
    });
    return;
  }

  // Honor a cancellation that landed before we picked the plan up.
  if (plan.cancel_requested) {
    process.stdout.write(`brain: cancelled '${plan.slug}' before preparing; removing.\n`);
    if (!dryRun) {
      await inboxStore.remove(plan.slug, { allowPreparing: true }).catch((err) => {
        if (!(err instanceof PlanNotFound)) throw err;
      });
      try {
        await fs.unlink(planFilePath(plan));
      } catch {
        // ignore
      }
    }
    return;
  }

  let body: string;
  try {
    body = await fs.readFile(planFilePath(plan), 'utf8');
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stderr.write(
        `error: plan file missing for '${plan.slug}' (${plan.path}); removing from inbox.\n`,
      );
      if (!dryRun) {
        await inboxStore.remove(plan.slug, { allowPreparing: true }).catch(() => undefined);
      }
      return;
    }
    throw err;
  }

  const controller = new AbortController();

  // Mark `preparing` BEFORE invoking claude — the TUI watches for this
  // to know which inbox plans can still be cancelled mid-flight. Register
  // the abort controller first so a fast SIGUSR2 after the claim is not lost.
  if (!dryRun) {
    state.current = plan.slug;
    state.controller = controller;
    try {
      await inboxStore.update(plan.slug, { status: 'preparing' }, { allowPreparing: true });
    } catch (err) {
      state.current = null;
      state.controller = null;
      if (err instanceof PlanNotFound) {
        process.stdout.write(`brain: skipped '${plan.slug}' after losing inbox claim.\n`);
        return;
      }
      throw err;
    }
  }

  if (dryRun) {
    state.current = plan.slug;
    state.controller = controller;
  }
  process.stdout.write(`brain: placing '${plan.slug}' (${plan.title})…\n`);

  let decision: Awaited<ReturnType<typeof brainPlacePlan>>;
  try {
    decision = await brainPlacePlan(todoStore, plan, body, controller.signal);
  } catch (err) {
    state.current = null;
    state.controller = null;
    if (err instanceof ClaudeAborted) {
      // Cancellation arrived mid-placement. Drop the plan and the .md
      // file so the user sees the row disappear.
      process.stdout.write(`brain: cancelled '${plan.slug}' during preparation.\n`);
      if (!dryRun) {
        await inboxStore.remove(plan.slug, { allowPreparing: true }).catch((cleanupErr) => {
          if (!(cleanupErr instanceof PlanNotFound)) throw cleanupErr;
        });
        try {
          await fs.unlink(planFilePath(plan));
        } catch {
          // ignore
        }
      }
      return;
    }
    // Restore status to 'enqueued' so the next loop iteration retries.
    if (!dryRun) {
      await inboxStore
        .update(plan.slug, { status: 'enqueued' }, { allowPreparing: true })
        .catch(() => undefined);
    }
    throw err;
  }
  state.current = null;
  state.controller = null;

  if (dryRun) {
    process.stdout.write(`[dry-run] would ${describePlaceDecision(decision, plan)}\n`);
    return;
  }

  // Add to todo as `ready`. Strip `preparing` status before insert.
  const readyPlan: Plan = { ...plan, status: 'ready', cancel_requested: false };
  await todoStore.add(readyPlan);
  const summary = await applyPlaceDecision(todoStore, readyPlan, decision);
  process.stdout.write(`brain: ${summary}\n`);
  await inboxStore.remove(plan.slug, { allowPreparing: true }).catch((err) => {
    if (!(err instanceof PlanNotFound)) throw err;
  });
}

async function cmdOrganize(opts: { once: boolean; dryRun: boolean }): Promise<number> {
  await fs.mkdir(LAUREN_DIR, { recursive: true });
  const todoStore = new TodoStore();
  const inboxStore = new InboxStore();

  const releaseBrainLock = await tryAcquireBrainLock();
  if (releaseBrainLock === null) {
    process.stderr.write(
      `error: another lauren organize daemon is already running in this repo ` +
        `(lock: ${displayPath(BRAIN_LOCK_PATH)}).\n`,
    );
    return 1;
  }

  const releasePidFile = await writePidFile(BRAIN_PID_PATH, 'lauren-organize');

  if (!opts.once) {
    process.stdout.write('🧠 lauren organize started. Ctrl-C to stop.\n');
  }
  if (opts.dryRun) {
    process.stdout.write('(dry-run mode — no mutations)\n');
  }

  const abortController = new AbortController();
  const cancelState: BrainCancelState = { current: null, controller: null };

  let interrupts = 0;
  const sigint = (): void => {
    interrupts += 1;
    if (interrupts === 1) {
      abortController.abort();
      process.stderr.write(
        '\n(Ctrl-C received — finishing current placement; press again to force.)\n',
      );
      return;
    }
    process.stderr.write('\n(forced exit)\n');
    process.exit(130);
  };
  process.on('SIGINT', sigint);

  // SIGUSR2: TUI sets `cancel_requested=true` on a plan and signals us.
  // We re-read the inbox; if our currently-preparing plan is now cancel-
  // requested, abort the claude subprocess. The cancellation is finalized
  // in processInboxPlan's catch block.
  const sigusr2 = async (): Promise<void> => {
    const slug = cancelState.current;
    if (!slug) return;
    try {
      const fresh = await inboxStore.find(slug);
      if (fresh?.cancel_requested) {
        cancelState.controller?.abort();
      }
    } catch {
      // ignore
    }
  };
  process.on('SIGUSR2', () => {
    void sigusr2();
  });

  let exitCode = 0;
  try {
    while (!abortController.signal.aborted) {
      const plans = await inboxStore.read();
      if (plans.length === 0) {
        if (opts.once) break;
        await sleepMs(BRAIN_IDLE_POLL_MS, abortController.signal);
        continue;
      }

      const next = plans[0]!;
      try {
        await processInboxPlan({
          plan: next,
          todoStore,
          inboxStore,
          dryRun: opts.dryRun,
          state: cancelState,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`brain: failed to process '${next.slug}': ${msg}\n`);
        if (opts.once) {
          exitCode = 1;
          break;
        }
        // Back off briefly so we don't hot-loop on the same broken plan.
        await sleepMs(BRAIN_IDLE_POLL_MS, abortController.signal);
      }
    }
  } finally {
    process.off('SIGINT', sigint);
    await releasePidFile().catch(() => undefined);
    await releaseBrainLock().catch(() => undefined);
  }

  if (!opts.once && abortController.signal.aborted) {
    process.stdout.write('lauren organize stopped.\n');
  }
  return exitCode;
}

async function main(): Promise<void> {
  const program = new Command();
  program.name('lauren').description('Queue-driven plan/vibe lifecycle runner.').version('0.1.0');

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
    .description(
      'drain .lauren/inbox.json into the todo via AI placement (long-running daemon); ' +
        'use --all to also re-think the whole ready queue',
    )
    .option('--once', 'drain inbox until empty, then exit', false)
    .option('--dry-run', 'print what brain would decide without applying', false)
    .option('--all', 're-think the whole ready todo queue (one-shot, may reorder and merge)', false)
    .option('-y, --yes', 'apply --all without asking for confirmation', false)
    .action(async (opts: { once: boolean; dryRun: boolean; all: boolean; yes: boolean }) => {
      if (opts.all) {
        process.exit(await cmdOrganizeAll({ yes: opts.yes, dryRun: opts.dryRun }));
      }
      process.exit(await cmdOrganize({ once: opts.once, dryRun: opts.dryRun }));
    });

  program
    .command('todo')
    .description('show the merged inbox+todo table (interactive TUI; --list for plain table)')
    .option('--list', 'print a static table and exit (no TUI)', false)
    .action(async (opts: { list: boolean }) => {
      process.exit(opts.list ? await cmdTodoList() : await cmdTodoTui());
    });

  configureVibeCommand(program.command('vibe'));

  program
    .command('_register', { hidden: true })
    .argument('<slug>')
    .requiredOption('--path <path>', 'path to the plan .md file')
    .requiredOption('--title <title>', 'display title for the plan')
    .option('--repo <repo>', 'target repo name/path from .lauren/workspace.json', collect, [])
    .action(async (slug: string, opts: { path: string; title: string; repo: string[] }) => {
      process.exit(
        await cmdRegister({
          slug,
          path: opts.path,
          title: opts.title,
          repos: opts.repo,
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
