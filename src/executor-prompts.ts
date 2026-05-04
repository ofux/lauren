import type { Plan } from './core/types.js';

export interface PR {
  id: string;
  title: string;
}

export function implementPrompt(pr: PR, planPath: string): string {
  return (
    `Implement PR ${pr.id} ("${pr.title}") as described in @${planPath}. ` +
    `Read the full PR section first, then implement everything listed under Scope. ` +
    `Stay strictly within the PR scope — do not touch items listed under "Out of scope". ` +
    `Stop when the scope is complete; do not commit (the orchestrator will commit).`
  );
}

export function reviewPrompt(pr: PR, planPath: string): string {
  return (
    `Review the uncommitted changes for PR ${pr.id} (${pr.title}). ` +
    `Run \`git status\` and \`git diff HEAD\` (and inspect untracked files) to see the ` +
    `staged, unstaged, and untracked changes — review only those. ` +
    `The PR description is in @${planPath} (search for '### PR ${pr.id}'). ` +
    `Check for: correctness, scope creep vs the PR's Scope/Out-of-scope sections, ` +
    `bugs, security issues, and missing exit-criteria items. Be specific and actionable.`
  );
}

export function fixPrompt(pr: PR, reviewText: string): string {
  return (
    `${reviewText}\n\n` +
    `---\n` +
    `Above is review feedback on your uncommitted changes for PR ${pr.id} (${pr.title}). ` +
    `For each comment, decide if it is legitimate. Implement the fixes you agree with. ` +
    `For nitpicks or comments you disagree with, skip them and at the end print a short ` +
    `list of what you skipped and why. Do not commit (the orchestrator will commit).`
  );
}

export function implementPlanPrompt(plan: Plan, planText: string): string {
  return (
    `Implement the plan "${plan.title}" described below. ` +
    `Read it carefully, then execute every step. ` +
    `Stay strictly within the plan's scope — do not make changes outside what it lists. ` +
    `Stop when the plan is complete; do not commit (the orchestrator will commit).\n\n` +
    `---\n\n${planText}`
  );
}

export function reviewPlanPrompt(plan: Plan): string {
  return (
    `Review the uncommitted changes for plan "${plan.title}" (slug: ${plan.slug}). ` +
    `Run \`git status\` and \`git diff HEAD\` (and inspect untracked files) to see ` +
    `the staged, unstaged, and untracked changes — review only those. ` +
    `The plan description is at @${plan.path}. ` +
    `Check for: correctness, scope creep vs the plan, bugs, security issues, ` +
    `and missing items from the plan's exit criteria. Be specific and actionable.`
  );
}

export function fixPlanPrompt(plan: Plan, reviewText: string): string {
  return (
    `${reviewText}\n\n` +
    `---\n` +
    `Above is review feedback on your uncommitted changes for plan "${plan.title}". ` +
    `For each comment, decide if it is legitimate. Implement the fixes you agree with. ` +
    `For nitpicks or comments you disagree with, skip them and at the end print a short ` +
    `list of what you skipped and why. Do not commit (the orchestrator will commit).`
  );
}

export function prCommitMessage(plan: Plan, pr: PR): string {
  return `${plan.slug}: PR ${pr.id} — ${pr.title}`;
}

export function planCommitMessage(plan: Plan): string {
  return `Plan: ${plan.title}`;
}
