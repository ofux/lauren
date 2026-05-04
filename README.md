# lauren

Lauren is a queue-driven plan/vibe lifecycle runner. You write plans in
your terminal, drop them on a queue, and a watcher process drains the
queue end-to-end (claude → codex review → claude → commit) without
further input.

## Install

Requires Node.js ≥ 20.

```sh
git clone <this-repo> lauren && cd lauren
npm install
npm run build
npm link        # exposes `lauren` and `vibe` on $PATH
```

`lauren` and `vibe` operate on the current working directory — run them
from inside the project you want to plan/execute against.

## Workflow

```
lauren spec                          # optional: write docs/PRD.md, ARCHITECTURE.md, TESTING.md
lauren plan "what to plan"           # interactive: produces .lauren/plans/<slug>.md and queues it
lauren todo list                     # inspect the queue
lauren organize                      # AI re-organize the pending queue (reorder + merge)
vibe                                 # infinite watcher; Ctrl-C to stop
vibe retry <slug>                    # flip a failed/in-progress plan back to pending
vibe rm <slug> [--purge]             # remove a plan from the queue
```

`vibe` runs in one terminal as a daemon; `lauren plan` in another keeps
appending work. Plans land as one commit each (single-unit), or as
multiple `### PR X.Y — Title` sections inside one plan that vibe walks
PR-by-PR. State lives in `.lauren/todo.json`; logs in `.lauren/logs/<slug>/`.

## Development

```sh
npm run build          # tsc → dist/
npm run watch          # rebuild on save
npm run clean          # remove dist/
npm run check          # biome check (lint + format + organize-imports), --write
npm run lint           # biome lint only
npm run format         # biome format --write
```

The source tree under `src/`:

- `bin/lauren.ts`, `bin/vibe.ts` — CLI entry points
- `core/` — paths, store, plan types, slug + time helpers
- `proc/` — subprocess streaming, claude/codex/git wrappers
- `tui/` — Ink components (`App`, `WatcherProgress`, `PlanProgress`)
- `executor.ts` + `executor-prompts.ts` — the implement→review→fix→commit pipeline
- `brain.ts` + `lauren-prompts.ts` — AI brain placement + system prompts
