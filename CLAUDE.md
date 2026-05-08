# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run build       # tsc → dist/, then chmod +x the lauren bin
npm run watch       # tsc --watch
npm run clean       # remove dist/
npm run check       # biome check --write (lint + format + organize-imports)
npm run lint        # biome lint only
npm run format      # biome format --write
npm test            # vitest run (one-shot)
npm run test:watch  # vitest in watch mode
```

Tests live next to source as `*.test.ts` (Vitest, ESM, Node `>=20`). Verify changes by `npm run build && npm run check && npm test`. Manual smoke test: from a throwaway repo, run `lauren vibe --dry-run` to print the queue, and `lauren todo --list` to inspect state (plain table; omit `--list` for the interactive TUI).

## External binaries

The runtime shells out to two CLIs that must be on `$PATH`:
- `claude` — used both interactively (planning, spec) and one-shot with `--output-format stream-json` (implement, fix, brain JSON decisions).
- `codex` — invoked as `codex exec review -o <file> <prompt>` for the review step.

If either is missing, `lauren vibe` will fail at the corresponding step.

## Architecture

Lauren is a single-daemon system that drains a plan queue end-to-end without further human input.

**`lauren` CLI (`src/bin/lauren.ts`)** — the single public executable. `lauren plan` spawns interactive `claude` with `PLAN_SYSTEM_PROMPT`; that claude session writes `.lauren/plans/<slug>.md` and re-invokes the CLI as `lauren _register <slug> --path ... --title ...` (a hidden subcommand) to enqueue into `.lauren/inbox.json`. `lauren todo` is an interactive Ink TUI (`src/tui/TodoApp.tsx`) showing inbox + todo rows merged; selecting a row dispatches to `cancelPlan` (`src/cancel.ts`) which routes by status (see *Cancellation* below). `lauren reorganize` is a one-shot CLI that re-thinks the whole `ready` queue via the brain (refuses if `lauren vibe` is running).

**`lauren vibe` (`src/vibe-command.ts` + `src/watcher.ts`)** — the unified daemon. Each loop iteration (a) drains the inbox completely via *brain* (`brainPlacePlan` in `src/brain.ts`, called from `processInboxPlan` in `src/organize.ts`), placing each plan into the todo as `ready`; then (b) claims one `ready` plan (status → `implementing`), runs the 4-step pipeline in `src/executor.ts`, and marks `done` (or `failed`). Renders progress via Ink (`src/tui/App.tsx` + `runtime.ts`) with distinct UI for the `organizing` and `implementing` phases. On Ctrl-C it demotes the in-flight plan back to `ready` so it can resume cleanly.

### The 4-step pipeline (`src/executor.ts`)

For each work unit (a whole plan, or a single PR section within a plan):

1. **implement** — `claude -p` with `implementPrompt`/`implementPlanPrompt`. If claude exits 0 but produces no diff, the unit short-circuits as "already done": review/fix/commit are marked `skipped`, the PR row finalizes as `done` with `commit_subject: null`, and the executor moves on. This lets the queue drain past PRs that a human or another agent already implemented instead of getting stuck.
2. **review** — `codex exec review -o <file>` with `reviewPrompt`. Reads the `-o` file as the structured review.
3. **fix** — `claude -p` with `fixPrompt`, given the review text. Skipped if review was empty.
4. **commit** — `git add -A && git commit -m <message>`. Subject format is `<slug>: PR X.Y — <title>` for PR units, `Plan: <title>` for single-unit plans.

### Plan modes (single-unit vs. multi-PR)

A plan file is **multi-PR** if it contains lines matching `^### PR (\d+\.\d+) — (.+)$` (parsed by `parsePrs`). Each match becomes one PR run with its own commit. Otherwise the entire plan is a **single unit** with one commit (`runPlanSingleUnit`).

**Resume semantics** (multi-PR only): `alreadyDone()` greps `git log --pretty=%s` for `<slug>: PR X.Y — ` subjects and skips matching PRs. This is how `lauren vibe retry <slug>` after a partial failure picks up where it left off.

### State and concurrency

Two stores hold the queue:

- `.lauren/inbox.json` (via `InboxStore`) — incoming registrations awaiting brain placement. Statuses there: `enqueued`, `preparing`.
- `.lauren/todo.json` (via `TodoStore`) — placed plans the executor consumes. Statuses there: `ready`, `implementing`, `failed`, `done`, `cancelled`.

Both files are schema-versioned; legacy values are migrated on read by `migratePlanRecord` (`core/types.ts`): inbox `pending` → `enqueued`; todo `pending` → `ready`, `in_progress` → `implementing`. All mutations serialize via `proper-lockfile` on the matching `*.lock`.

Status machine: `enqueued → preparing → ready → implementing → done | failed | cancelled`.

Locking invariants: while a plan is `implementing`, only the executor (passing `allowImplementing: true`) may mutate the todo row. External operations throw `ImplementingLocked` otherwise. The same protection applies to `preparing` rows in the inbox (`PreparingLocked`); only the vibe daemon's brain phase may mutate them.

`lauren vibe` refuses to start if (a) the working tree is dirty, or (b) any plan is already `implementing` (likely a crashed prior run — user must clean up and `lauren vibe retry <slug>`). Any `preparing` rows left over from a crashed prior run are demoted back to `enqueued` on startup so the brain phase will replace them fresh.

### Cancellation (`src/cancel.ts`)

`lauren todo`'s TUI dispatches per-status cancellation:

- `enqueued` → remove from inbox + delete the plan `.md`.
- `preparing` → set `cancel_requested=true` on the inbox row, send `SIGUSR2` to vibe via `.lauren/vibe.pid`. Vibe's SIGUSR2 handler dispatches by phase: in `organizing`, the brain's claude subprocess is aborted (AbortSignal plumbed through `runClaudeOneshotJson`) and the row + `.md` are dropped.
- `ready` → set status to `cancelled` directly.
- `implementing` → set `cancel_requested=true` on the todo row, send `SIGUSR2` to vibe via `.lauren/vibe.pid`. Vibe aborts the in-flight subprocess, runs `revertWorkingTree` (`git checkout -- … && git clean -fd …` excluding `.lauren/`), and finalizes the row to `cancelled`.
- `failed | done | cancelled` → no-op.

The vibe daemon writes its PID on startup (`src/proc/pid.ts`) and removes it on clean shutdown. If the daemon isn't running, the `cancel_requested` flag persists and is honored on the daemon's next start.

### Subprocess streaming (`src/proc/`)

`stream.ts` exposes `streamSubprocess` which spawns a child, tees stdout to a log file (`.lauren/logs/<slug>/...`), and forwards parsed lines into a `ProgressSink` (the TUI bridge implemented by `WatcherRuntime`). Claude's stream-json output is decoded by `formatClaudeStreamLine` (`src/util/streamJson.ts`); other tools stream raw lines.

### TUI (`src/tui/`)

Ink/React. `WatcherRuntime` is both the mutable state container *and* the `ProgressSink` the executor sees — it forwards `beginItem`/`beginStep`/`appendLog` calls into React state and notifies subscribers. The `App` component renders either an idle/paused message or `WatcherProgress` + `PlanProgress` while running.

## Conventions

- ESM only — `"type": "module"` in package.json, NodeNext resolution. **All relative imports must use `.js` extensions** even when the source is `.ts` (TypeScript NodeNext requires this). Example: `import { TodoStore } from '../core/store.js';`
- TS strict mode, including `noUncheckedIndexedAccess` — array/map indexing returns `T | undefined` and must be narrowed.
- Biome enforces: single quotes, semicolons, trailing commas, 100-col lines, 2-space indent. `useImportType` is errored — always `import type { ... }` for type-only imports.
- All paths flow through `src/core/paths.ts`, which derives everything from `process.cwd()` (the *target* repo, not the lauren install). Don't read `__dirname`-relative paths.
