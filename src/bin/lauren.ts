#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';

import { printTodoTable } from '../cli/table.js';
import {
  ARCH_PATH,
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
import { PlanStore } from '../core/store.js';
import { nowIso } from '../core/time.js';
import { type Plan, planFilePath, SlugCollision } from '../core/types.js';
import { formatRepoList, resolveWorkspaceRepos, WorkspaceConfigError } from '../core/workspace.js';
import { PLAN_SYSTEM_PROMPT, SPEC_SYSTEM_PROMPT } from '../lauren-prompts.js';
import { runClaudeInteractive } from '../proc/claude.js';
import { slugHasLaurenHistory } from '../proc/git.js';
import { TodoApp } from '../tui/TodoApp.js';
import { confirm } from '../util/confirm.js';
import { parsePlanFrontmatter } from '../util/planFrontmatter.js';
import { configureVibeCommand } from '../vibe-command.js';

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

  // Orphan check — a plan is "registered" if it lives in the store.
  if (await fileExists(PLANS_DIR)) {
    const store = new PlanStore();
    const allPlans = await store.read();
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
    steps: null,
  };

  let rawBody: string;
  try {
    rawBody = await fs.readFile(planFilePath(plan), 'utf8');
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stderr.write(`error: plan file not found: ${plan.path}\n`);
      return 1;
    }
    throw err;
  }

  const { frontmatter } = parsePlanFrontmatter(rawBody);
  if (!frontmatter) {
    process.stderr.write(
      `error: ${plan.path} is missing a frontmatter block. ` +
        `Add a YAML block at the very top with \`name: ${args.slug}\` and a ` +
        `3–4 line \`description: |\` summary, then retry.\n`,
    );
    return 1;
  }
  if (frontmatter.name !== args.slug) {
    process.stderr.write(
      `error: frontmatter \`name\` is '${frontmatter.name}' but registered slug is ` +
        `'${args.slug}'. Update the file so they match, then retry.\n`,
    );
    return 1;
  }
  if (frontmatter.description.trim() === '') {
    process.stderr.write(
      `error: frontmatter \`description\` is empty in ${plan.path}. ` +
        `Provide a 3–4 line summary, then retry.\n`,
    );
    return 1;
  }

  const store = new PlanStore();
  try {
    await store.add(plan);
  } catch (err) {
    if (err instanceof SlugCollision) {
      process.stderr.write(
        `error: slug '${args.slug}' already queued; pick a more specific name.\n`,
      );
      return 1;
    }
    throw err;
  }

  const summaryBlock = frontmatter.description
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  process.stdout.write(
    `queued '${args.slug}' as enqueued — ${args.title}\n` +
      `summary:\n${summaryBlock}\n` +
      `target repo(s): ${formatRepoList(targetRepos)}\n` +
      `(run \`lauren vibe\` to let the AI place it into the todo queue and execute it.)\n`,
  );
  return 0;
}

async function cmdTodoList(): Promise<number> {
  const store = new PlanStore();
  const plans = await store.read();
  if (plans.length === 0) {
    process.stdout.write('(empty queue)\n');
    return 0;
  }
  printTodoTable(plans);
  return 0;
}

async function cmdTodoTui(): Promise<number> {
  // Non-TTY (pipe, redirected output, CI): print a static table and exit.
  if (!process.stdout.isTTY) {
    return cmdTodoList();
  }

  const store = new PlanStore();

  const inkApp = render(React.createElement(TodoApp, { store }), {
    exitOnCtrlC: true,
  });

  await inkApp.waitUntilExit();
  return 0;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('lauren')
    .description('Queue-driven plan/vibe lifecycle runner.')
    .version('0.1.0')
    .allowExcessArguments(false)
    .option('--list', 'print a static table and exit (no TUI)', false)
    .action(async (opts: { list: boolean }) => {
      process.exit(opts.list ? await cmdTodoList() : await cmdTodoTui());
    });

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
