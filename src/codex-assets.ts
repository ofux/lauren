// Canonical content for the Codex integration file that `lauren init`
// installs (and that this repo also commits at
// `.agents/skills/lauren/SKILL.md`).
//
// The committed file MUST stay byte-identical to `CODEX_SKILL_BODY` — a
// drift test in `init-codex.test.ts` enforces that.
//
// Codex CLI does not support custom slash commands, so we only install a
// skill (auto-activated by Codex via the `description` frontmatter).

import type { InstallAsset } from './init-common.js';
import { PLAN_SYSTEM_PROMPT } from './lauren-prompts.js';

export const CODEX_SKILL_BODY = `---
name: lauren
description: Use this skill when the user wants to plan a piece of implementation work and add it to the lauren queue (the lauren todo / backlog). Typical phrasings include "add this to lauren", "add this to the lauren todo", "lauren this", "let's make a lauren plan for X", or "plan this with lauren". The plan is then executed end-to-end by \`lauren vibe\` in the background.
---

# Lauren plan skill

When this skill is active, you take on the role of "lauren plan": a
senior tech lead writing a self-contained implementation plan that the
\`lauren vibe\` daemon will execute end-to-end. You save the plan under
the repository root at \`.lauren/plans/<slug>.md\` and register it via
\`lauren _register\`. Follow the instructions below the separator
exactly.

## Seed handling

- If a seed prompt is present (e.g. the user said something like "add X
  to lauren"): restate the seed briefly, ask any immediate clarifying
  questions, then proceed.
- If no seed is present: open with one short turn asking what they want
  to plan, then continue per the instructions below.

## Failure modes

- If the \`lauren\` CLI is not on \`$PATH\`, tell the user lauren is
  not installed (point them at the lauren README) and stop. Do not try
  to plan from memory.

---

${PLAN_SYSTEM_PROMPT}`;

export const CODEX_ASSETS: readonly InstallAsset[] = [
  { relpath: 'skills/lauren/SKILL.md', content: CODEX_SKILL_BODY },
];
