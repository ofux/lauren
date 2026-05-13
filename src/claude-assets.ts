// Canonical content for the Claude Code integration files that
// `lauren init` installs (and that this repo also commits at
// `.claude/commands/lauren.md` and `.claude/skills/lauren/SKILL.md`).
//
// The committed files MUST stay byte-identical to these constants — a
// drift test in `init-claude.test.ts` enforces that.

export const CLAUDE_SKILL_BODY = `---
name: lauren
description: Plan a new piece of implementation work and add it to the lauren queue (the lauren todo / backlog). Use when the user wants to queue work for lauren to execute autonomously, add an item to lauren, snapshot a discussion into a lauren plan, or says things like "add this to lauren", "add this to the lauren todo", "lauren this", "let's make a lauren plan for X", "plan this with lauren".
---

# Lauren plan skill

When this skill is active, you take on the role of "lauren plan": a
senior tech lead writing a self-contained implementation plan that the
\`lauren vibe\` daemon will execute end-to-end. You save the plan under
the repository root at \`.lauren/plans/<slug>.md\` and register it via
\`lauren _register\`.

## Load the governing instructions

Before doing anything else, run this Bash command and read its full
stdout:

    repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)" && printf 'repo root: %s\\n' "$repo_root" && cd "$repo_root" && lauren _plan-prompt

The printed repo root is the workspace root for all later file paths.
The prompt output is your authoritative instruction set for the rest of
this session — how to explore, ask clarifying questions in batches,
propose, iterate, decide single-unit vs. multi-step, write frontmatter,
and register. Follow it exactly.

## Repository root anchoring

- Treat all relative paths in the loaded prompt as relative to the
  printed repo root, not necessarily Claude Code's current working
  directory.
- When writing the plan, either use the absolute path
  \`$repo_root/.lauren/plans/<slug>.md\` or ensure the Write tool is
  rooted at the printed repo root.
- When registering, run \`lauren _register\` from \`$repo_root\` or pass
  the same absolute plan path you wrote. Do not write a plan under a
  nested subdirectory's \`.lauren/\` directory.
- Shell variables do not persist between Bash calls. In later commands,
  either substitute the printed repo root path or recompute
  \`repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"\`.

## Seed handling

- If a seed prompt is present (e.g. the user invoked \`/lauren <text>\`
  or said something like "add X to lauren"): restate the seed briefly,
  ask any immediate clarifying questions, then proceed.
- If no seed is present (bare \`/lauren\`): open with one short turn
  asking what they want to plan, then continue per the loaded prompt.

## Failure modes

- If \`lauren _plan-prompt\` is not on \`$PATH\` or exits non-zero,
  tell the user lauren is not installed or set up (point them at the
  lauren README) and stop. Do not try to plan from memory.
`;

export const CLAUDE_COMMAND_BODY = `---
description: Plan a new piece of work and add it to the lauren queue
argument-hint: [optional seed prompt]
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep]
---

The user wants to plan a piece of implementation work and add it to the
lauren queue. Use the \`lauren\` skill to handle this end-to-end.

Seed prompt (may be empty): $ARGUMENTS
`;

export interface ClaudeAsset {
  /** Path relative to the chosen `.claude/` directory. */
  relpath: string;
  content: string;
}

export const CLAUDE_ASSETS: readonly ClaudeAsset[] = [
  { relpath: 'commands/lauren.md', content: CLAUDE_COMMAND_BODY },
  { relpath: 'skills/lauren/SKILL.md', content: CLAUDE_SKILL_BODY },
];
