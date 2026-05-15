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

Tests live next to source as `*.test.ts` (Vitest, ESM, Node `>=20`). Verify changes by `npm run build && npm run check && npm test`. Manual smoke test: from a throwaway repo, run `lauren vibe --dry-run` to print the queue, and `lauren --list` to inspect state (plain table; omit `--list` for the interactive TUI).

## External binaries

The runtime shells out to two CLIs that must be on `$PATH`:
- `claude` — used interactively (planning, spec) and as the default agent for the implement / fix pipeline phases, brain JSON decisions, and merger conflict resolution.
- `codex` — used as the default agent for the review pipeline phase (`codex exec review -o <file> <prompt>`).

Per-phase agent selection is configurable in `.lauren/config.json` under
`agents`: each of `implement`, `review`, `fix`, `merger`, and `brain`
independently accepts `"claude"` or `"codex"`. The adapters live in
`src/agents/` and implement the `CodingAgent` port (`runEdit`, `runReview`,
`runJson`) — see `src/agents/types.ts`.

If a binary is missing for any role configured to use it, `lauren vibe` will
fail at the corresponding step.

## Architecture

Lauren is a single-daemon system that drains a plan queue end-to-end without further human input.

**`lauren` CLI (`src/bin/lauren.ts`)** — the single public executable. `lauren plan` spawns interactive `claude` with `PLAN_SYSTEM_PROMPT`; that claude session writes `.lauren/plans/<slug>.md` and re-invokes the CLI as `lauren _register <slug> --path ... --title ...` (a hidden subcommand) to add a row with status `enqueued` to `.lauren/plans.json`. The default `lauren` (no subcommand) is an interactive Ink TUI (`src/tui/TodoApp.tsx`) showing the queue; `--list` (or non-TTY) prints a static colored table instead. Selecting a row dispatches to `cancelPlan` (`src/cancel.ts`) which routes by status (see *Cancellation* below). The TUI also supports two queue-level actions: `t` on a `failed` row resets it to `ready` via `retryPlan` (`src/retry.ts`), and `r` triggers a brain reorganize pass that re-thinks the whole `ready` queue (refused while `lauren vibe` is running, detected via `.lauren/vibe.pid`).

**Claude Code surface (`src/init-claude.ts` + `src/claude-assets.ts`)** — `lauren init` writes two files into the target's (or user's, with `--global`) `.claude/`: a `lauren` skill that auto-activates on intents like *"add this to lauren"*, and a `/lauren` slash command for explicit invocation. Both delegate to the same `PLAN_SYSTEM_PROMPT`, loaded at runtime via the hidden `lauren _plan-prompt` subcommand — single source of truth. The repo itself commits the canonical files at `.claude/commands/lauren.md` and `.claude/skills/lauren/SKILL.md`; a drift test in `src/init-claude.test.ts` enforces byte-equality with `src/claude-assets.ts`.

**`lauren vibe` (`src/vibe-command.ts` + `src/watcher.ts`)** — the unified daemon. Each loop iteration (a) drains every `enqueued` plan via *brain* (`brainPlacePlan` in `src/brain.ts`, called from `processEnqueuedPlan` in `src/organize.ts`), transitioning each row from `enqueued` → `preparing` → `ready` in place; then (b) claims one `ready` plan (status → `implementing`), runs the 4-step pipeline in `src/executor.ts`, and marks `done` (or `failed`). Renders progress via Ink (`src/tui/App.tsx` + `runtime.ts`) with distinct UI for the `organizing` and `implementing` phases. On Ctrl-C it demotes the in-flight plan back to `ready` so it can resume cleanly.

### The 4-phase pipeline (`src/executor.ts`)

For each work unit (a whole plan, or a single Step section within a plan):

1. **implement** — `claude -p` with `implementPrompt`/`implementPlanPrompt`. If claude exits 0 but produces no diff, the unit short-circuits as "already done": review/fix/commit are marked `skipped`, the Step row finalizes as `done` with `commit_subject: null`, and the executor moves on. This lets the queue drain past Steps that a human or another agent already implemented instead of getting stuck.
2. **review** — `codex exec review -o <file>` with `reviewPrompt`. Reads the `-o` file as the structured review.
3. **fix** — `claude -p` with `fixPrompt`, given the review text. Skipped if review was empty.
4. **commit** — `git add -A && git commit -m <message>`. Subject format is `<slug>: Step X.Y — <title>` for Step units, `Plan: <title>` for single-unit plans.

> Terminology note: a plan is divided into outer **Steps** (`### Step X.Y — …` sections, each its own commit); each Step runs through the four inner **Phases** above (implement / review / fix / commit). "Step" and "Phase" are used consistently throughout the code — `Step`/`StepEntry` for the outer concept, `PhaseName`/`STEP_PHASES` for the inner one.

### Plan modes (single-unit vs. multi-step)

A plan file is **multi-step** if it contains lines matching `^### Step (\d+\.\d+) — (.+)$` (parsed by `parseSteps`). Each match becomes one Step run with its own commit. Otherwise the entire plan is a **single unit** with one commit. Both are handled by `runUnit` in `executor.ts` — the only difference is which prompts run and whether the log dir is per-Step.

**Resume semantics** (multi-step only): per-Step state lives on the plan row in `plan.steps[]` (see `src/core/steps.ts`). When the watcher claims a `ready` plan, `materializeSteps` re-parses the plan markdown and reconciles it against the stored list — Steps that already finished keep status `done` and are skipped; the executor only runs Steps with status `pending` or `failed`. Git history is not consulted. This is how pressing `t` on a failed row in `lauren` (which flips it back to `ready`) picks up where it left off after a partial failure.

### State and concurrency

`.lauren/plans.json` (via `PlanStore` in `src/core/store.ts`) holds the entire queue. The `status` field is the sole lifecycle discriminator:

- `enqueued` / `preparing` — pre-placement (brain hasn't decided where to put it yet).
- `ready` / `implementing` / `cancelling` / `failed` / `done` / `cancelled` — post-placement.

The file is schema-versioned (`SCHEMA_VERSION` in `core/types.ts`); `PlanStore.read()` rejects unsupported versions with `PlanStoreFormatError`. All mutations serialize via `proper-lockfile` on `.lauren/plans.json.lock`.

Status machine: `enqueued → preparing → ready → implementing → done | failed | cancelled | cancelling`. `cancelling` is a paused state: the user cancelled an `implementing` plan with intent `keep` (don't revert), so vibe stopped the subprocess but left the working tree dirty. Vibe pauses on `cancelling` rows (analogous to `failed`) until the user manually commits/stashes the partial work and flips status to `cancelled`.

Locking invariants: while a plan is `implementing`, only the executor (passing `allowImplementing: true`) may mutate the row. External operations throw `ImplementingLocked` otherwise. The same protection applies to `preparing` rows (`PreparingLocked`); only the vibe daemon's brain phase (passing `allowPreparing: true`) may mutate them.

`lauren vibe` refuses to start if (a) the working tree is dirty, or (b) any plan is already `implementing` (likely a crashed prior run — user must clean the working tree and manually edit `.lauren/plans.json` to flip `status` back to `ready`). Any `preparing` rows left over from a crashed prior run are demoted back to `enqueued` on startup so the brain phase will replace them fresh.

### Cancellation (`src/cancel.ts`)

The TUI dispatches per-status cancellation:

- `enqueued` → remove from the queue + delete the plan `.md`.
- `preparing` → set `cancel_requested=true` on the row, send `SIGUSR2` to vibe via `.lauren/vibe.pid`. Vibe's SIGUSR2 handler dispatches by phase: in `organizing`, the brain's claude subprocess is aborted (AbortSignal plumbed through `runClaudeOneshotJson`) and the row + `.md` are dropped.
- `ready` → set status to `cancelled` directly.
- `implementing` → set `cancel_requested=true` (plus `cancel_intent: 'revert' | 'keep'`) on the row, send `SIGUSR2` to vibe. Vibe aborts the in-flight subprocess, then branches on the intent: `revert` (default) runs `revertWorkingTree` (`git checkout -- … && git clean -fd …` excluding `.lauren/`) and finalizes the row to `cancelled`; `keep` leaves the working tree dirty and finalizes the row to `cancelling`, then pauses the loop until the user resolves it.
- `failed | done | cancelled | cancelling` → no-op.

The vibe daemon writes its PID on startup (`src/proc/pid.ts`) and removes it on clean shutdown. If the daemon isn't running, the `cancel_requested` flag persists and is honored on the daemon's next start.

### Subprocess streaming (`src/proc/`)

`stream.ts` exposes `streamSubprocess` which spawns a child, tees stdout to a log file (`.lauren/logs/<slug>/...`), and forwards parsed lines into a `ProgressSink` (the TUI bridge implemented by `WatcherRuntime`). Claude's stream-json output is decoded by `formatClaudeStreamLine` (`src/util/streamJson.ts`); other tools stream raw lines.

### TUI (`src/tui/`)

Ink/React. `WatcherRuntime` is both the mutable state container *and* the `ProgressSink` the executor sees — it forwards `beginItem`/`beginStep`/`appendLog` calls into React state and notifies subscribers. The `App` component renders either an idle/paused message or `WatcherProgress` + `PlanProgress` while running.

## Conventions

- ESM only — `"type": "module"` in package.json, NodeNext resolution. **All relative imports must use `.js` extensions** even when the source is `.ts` (TypeScript NodeNext requires this). Example: `import { PlanStore } from '../core/store.js';`
- TS strict mode, including `noUncheckedIndexedAccess` — array/map indexing returns `T | undefined` and must be narrowed.
- Biome enforces: single quotes, semicolons, trailing commas, 100-col lines, 2-space indent. `useImportType` is errored — always `import type { ... }` for type-only imports.
- All paths flow through `src/core/paths.ts`, which derives everything from `process.cwd()` (the *target* repo, not the lauren install). Don't read `__dirname`-relative paths.
