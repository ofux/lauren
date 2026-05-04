# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run build     # tsc → dist/, then chmod +x bin entrypoints
npm run watch     # tsc --watch
npm run clean     # remove dist/
npm run check     # biome check --write (lint + format + organize-imports)
npm run lint      # biome lint only
npm run format    # biome format --write
```

There is no test suite. Verify changes by `npm run build && npm run check`. Manual smoke test: from a throwaway repo, run `vibe --dry-run` to print the queue, and `lauren todo list` to inspect state.

## External binaries

The runtime shells out to two CLIs that must be on `$PATH`:
- `claude` — used both interactively (planning, spec) and one-shot with `--output-format stream-json` (implement, fix, brain JSON decisions).
- `codex` — invoked as `codex exec review -o <file> <prompt>` for the review step.

If either is missing, `vibe` will fail at the corresponding step.

## Architecture

Lauren is a two-process system that drains a plan queue end-to-end without further human input.

**`lauren` CLI (`src/bin/lauren.ts`)** — the *brain* side. Subcommands write/queue/organize plan files. `lauren plan` spawns interactive `claude` with `PLAN_SYSTEM_PROMPT`; that claude session writes `.lauren/plans/<slug>.md` and re-invokes the CLI as `lauren _register <slug> --path ... --title ...` (a hidden subcommand) to enqueue. After registration the *brain* (`brainPlacePlan` in `src/brain.ts`) runs a one-shot claude call to decide insert-position vs. merge-into-existing-plan, then mutates the queue accordingly. `lauren organize` does the same for the whole pending queue.

**`vibe` CLI (`src/bin/vibe.ts`)** — the *executor* daemon. Polls `.lauren/todo.json` every 3s. For each pending plan it claims (status → `in_progress`), runs the 4-step pipeline in `src/executor.ts`, then marks `done` (or `failed`). Renders progress via Ink (`src/tui/App.tsx` + `runtime.ts`). On Ctrl-C it demotes the in-flight plan back to `pending` so it can resume cleanly.

### The 4-step pipeline (`src/executor.ts`)

For each work unit (a whole plan, or a single PR section within a plan):

1. **implement** — `claude -p` with `implementPrompt`/`implementPlanPrompt`. Must produce a dirty working tree, else fails.
2. **review** — `codex exec review -o <file>` with `reviewPrompt`. Reads the `-o` file as the structured review.
3. **fix** — `claude -p` with `fixPrompt`, given the review text. Skipped if review was empty.
4. **commit** — `git add -A && git commit -m <message>`. Subject format is `<slug>: PR X.Y — <title>` for PR units, `Plan: <title>` for single-unit plans.

### Plan modes (single-unit vs. multi-PR)

A plan file is **multi-PR** if it contains lines matching `^### PR (\d+\.\d+) — (.+)$` (parsed by `parsePrs`). Each match becomes one PR run with its own commit. Otherwise the entire plan is a **single unit** with one commit (`runPlanSingleUnit`).

**Resume semantics** (multi-PR only): `alreadyDone()` greps `git log --pretty=%s` for `<slug>: PR X.Y — ` subjects and skips matching PRs. This is how `vibe retry <slug>` after a partial failure picks up where it left off.

### State and concurrency

State lives in `.lauren/todo.json` (schema versioned, see `core/types.ts`). All mutations go through `TodoStore` (`src/core/store.ts`), which serializes via `proper-lockfile` on `.lauren/todo.json.lock`. Status machine: `pending → in_progress → done | failed`.

Critical invariant: while a plan is `in_progress`, only the executor (passing `allowInProgress: true`) may mutate it. `lauren` brain operations and user commands like `vibe rm` will throw `InProgressLocked`. This prevents the planner side from mid-flight clobbering a running plan.

`vibe` refuses to start if (a) the working tree is dirty, or (b) any plan is already `in_progress` (likely a crashed prior run — user must clean up and `vibe retry <slug>`).

### Subprocess streaming (`src/proc/`)

`stream.ts` exposes `streamSubprocess` which spawns a child, tees stdout to a log file (`.lauren/logs/<slug>/...`), and forwards parsed lines into a `ProgressSink` (the TUI bridge implemented by `WatcherRuntime`). Claude's stream-json output is decoded by `formatClaudeStreamLine` (`src/util/streamJson.ts`); other tools stream raw lines.

### TUI (`src/tui/`)

Ink/React. `WatcherRuntime` is both the mutable state container *and* the `ProgressSink` the executor sees — it forwards `beginItem`/`beginStep`/`appendLog` calls into React state and notifies subscribers. The `App` component renders either an idle/paused message or `WatcherProgress` + `PlanProgress` while running.

## Conventions

- ESM only — `"type": "module"` in package.json, NodeNext resolution. **All relative imports must use `.js` extensions** even when the source is `.ts` (TypeScript NodeNext requires this). Example: `import { TodoStore } from '../core/store.js';`
- TS strict mode, including `noUncheckedIndexedAccess` — array/map indexing returns `T | undefined` and must be narrowed.
- Biome enforces: single quotes, semicolons, trailing commas, 100-col lines, 2-space indent. `useImportType` is errored — always `import type { ... }` for type-only imports.
- All paths flow through `src/core/paths.ts`, which derives everything from `process.cwd()` (the *target* repo, not the lauren install). Don't read `__dirname`-relative paths.
