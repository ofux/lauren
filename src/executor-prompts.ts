import type { Step } from './core/steps.js';
import type { Plan } from './core/types.js';

export type { Step };

function repoInstruction(repoPaths: readonly string[]): string {
  if (repoPaths.length === 0) return '';
  const rendered = repoPaths.map((repo) => `\`${repo}\``).join(', ');
  return ` The target repo${repoPaths.length === 1 ? '' : 's'} for this work: ${rendered}.`;
}

function notesInstruction(
  notesPath: string | null,
  sectionAttrs: string,
  phaseHint: 'implement' | 'fix',
): string {
  if (notesPath === null) return '';
  const lead =
    phaseHint === 'fix'
      ? `In addition to fixing review feedback, continue the implementation-notes file at ` +
        `\`${notesPath}\`. APPEND a new <section ${sectionAttrs}> with anything notable from ` +
        `this round of changes.`
      : `While you work, keep a running implementation-notes HTML file at \`${notesPath}\`. ` +
        `If it doesn't exist yet, create it with a minimal HTML5 skeleton (<!doctype html>, ` +
        `<title>, a top-level <h1> with the plan slug and title). APPEND a new ` +
        `<section ${sectionAttrs}> for this run — never overwrite or remove prior sections.`;
  return (
    `\n\n---\n${lead} The section should record: decisions you made that weren't in the spec, ` +
    `anything you changed from what the spec said and why, tradeoffs you made, and surprises ` +
    `or anything else the user should know. Skip the section entirely if you have nothing ` +
    `noteworthy to add — empty sections are worse than no section.`
  );
}

function stepSectionAttrs(stepId: string, phase: 'implement' | 'fix'): string {
  return `data-step="${stepId}" data-phase="${phase}"`;
}

function planSectionAttrs(phase: 'implement' | 'fix'): string {
  return `data-phase="${phase}"`;
}

function reviewGitInstruction(repoPaths: readonly string[]): string {
  if (repoPaths.length === 0) {
    return (
      `Run \`git status\` and \`git diff HEAD\` (and inspect untracked files) to see the ` +
      `staged, unstaged, and untracked changes — review only those. `
    );
  }
  const commands = repoPaths
    .map((repo) => `\`git -C ${repo} status --porcelain\` / \`git -C ${repo} diff HEAD\``)
    .join(', ');
  return (
    `Inspect the target repos from the workspace root with ${commands} ` +
    `(and inspect untracked files) — review only those changes. `
  );
}

export function implementPrompt(
  step: Step,
  planPath: string,
  repoPaths: readonly string[] = [],
  notesPath: string | null = null,
): string {
  return (
    `Implement Step ${step.id} ("${step.title}") as described in @${planPath}. ` +
    `You are running from the workspace root.${repoInstruction(repoPaths)} ` +
    `Read the full Step section first, then implement everything listed under Scope. ` +
    `Stay strictly within the Step scope — do not touch items listed under "Out of scope". ` +
    `Stop when the scope is complete; do not commit (the orchestrator will commit).` +
    notesInstruction(notesPath, stepSectionAttrs(step.id, 'implement'), 'implement')
  );
}

export function reviewPrompt(
  step: Step,
  planPath: string,
  repoPaths: readonly string[] = [],
): string {
  return (
    `Review the uncommitted changes for Step ${step.id} (${step.title}). ` +
    reviewGitInstruction(repoPaths) +
    `The Step description is in @${planPath} (search for '### Step ${step.id}'). ` +
    `Check for: correctness, scope creep vs the Step's Scope/Out-of-scope sections, ` +
    `bugs, security issues, and missing exit-criteria items. Be specific and actionable.`
  );
}

export function fixPrompt(step: Step, reviewText: string, notesPath: string | null = null): string {
  return (
    `${reviewText}\n\n` +
    `---\n` +
    `Above is review feedback on your uncommitted changes for Step ${step.id} (${step.title}). ` +
    `For each comment, decide if it is legitimate. Implement the fixes you agree with. ` +
    `For nitpicks or comments you disagree with, skip them and at the end print a short ` +
    `list of what you skipped and why. Do not commit (the orchestrator will commit).` +
    notesInstruction(notesPath, stepSectionAttrs(step.id, 'fix'), 'fix')
  );
}

export function implementPlanPrompt(
  plan: Plan,
  planText: string,
  repoPaths: readonly string[] = [],
  notesPath: string | null = null,
): string {
  return (
    `Implement the plan "${plan.title}" described below. ` +
    `You are running from the workspace root.${repoInstruction(repoPaths)} ` +
    `Read it carefully, then execute every step. ` +
    `Stay strictly within the plan's scope — do not make changes outside what it lists. ` +
    `Stop when the plan is complete; do not commit (the orchestrator will commit).` +
    notesInstruction(notesPath, planSectionAttrs('implement'), 'implement') +
    `\n\n---\n\n${planText}`
  );
}

export function reviewPlanPrompt(plan: Plan, repoPaths: readonly string[] = []): string {
  return (
    `Review the uncommitted changes for plan "${plan.title}" (slug: ${plan.slug}). ` +
    reviewGitInstruction(repoPaths) +
    `The plan description is at @${plan.path}. ` +
    `Check for: correctness, scope creep vs the plan, bugs, security issues, ` +
    `and missing items from the plan's exit criteria. Be specific and actionable.`
  );
}

export function fixPlanPrompt(
  plan: Plan,
  reviewText: string,
  notesPath: string | null = null,
): string {
  return (
    `${reviewText}\n\n` +
    `---\n` +
    `Above is review feedback on your uncommitted changes for plan "${plan.title}". ` +
    `For each comment, decide if it is legitimate. Implement the fixes you agree with. ` +
    `For nitpicks or comments you disagree with, skip them and at the end print a short ` +
    `list of what you skipped and why. Do not commit (the orchestrator will commit).` +
    notesInstruction(notesPath, planSectionAttrs('fix'), 'fix')
  );
}

export function stepCommitMessage(plan: Plan, step: Step): string {
  return `${plan.slug}: Step ${step.id} — ${step.title}`;
}

export function planCommitMessage(plan: Plan): string {
  return `${plan.slug}: Plan — ${plan.title}`;
}
