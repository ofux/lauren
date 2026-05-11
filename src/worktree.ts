import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { LaurenConfig } from './core/config.js';
import { displayPath, worktreePath, worktreeRootPath } from './core/paths.js';
import { type Plan, type PlanWorktree, planFilePath } from './core/types.js';
import { type ResolvedWorkspaceRepo, resolveWorkspaceRepos } from './core/workspace.js';
import {
  gitDeleteBranch,
  gitWorktreeAdd,
  gitWorktreeRemove,
  workingTreeDirty,
} from './proc/git.js';

export interface PlanExecutionContext {
  /** Subprocess cwd (claude/codex) — always the worktree root for this plan. */
  rootCwd: string;
  /**
   * `target_repos` rewritten so each entry's `root` points at the
   * corresponding per-repo worktree path (not the user's main checkout).
   * Git commit operations consume this list.
   */
  rewrittenRepos: ResolvedWorkspaceRepo[];
  /** Persisted on the plan row so cancellation + recovery can find them. */
  worktrees: PlanWorktree[];
}

/**
 * Encodes the conventional branch name for a plan's worktree. Kept in one
 * place so the merger, cleanup, and TUI all agree.
 */
export function planBranchName(slug: string): string {
  return `lauren/${slug}`;
}

/**
 * Determine whether the plan is single-repo (no workspace.json) or multi-repo.
 * The shape decides the worktree layout: single-repo uses one worktree at
 * the worktree root; multi-repo nests per-repo worktrees one level deeper.
 */
function isSingleRepoPlan(repos: readonly ResolvedWorkspaceRepo[]): boolean {
  return repos.length === 1 && repos[0]!.path === '.';
}

/**
 * Create the worktrees needed for a plan to enter `implementing`, copy the
 * plan markdown into each worktree, and return the execution context the
 * executor needs to run inside them.
 *
 * Idempotent against partial prior state: if a worktree already exists at
 * the expected path (from a crashed run that left state behind), it is
 * removed first so the new run starts on a clean tree.
 */
export async function setupPlanWorktrees(
  plan: Plan,
  config: LaurenConfig,
): Promise<PlanExecutionContext> {
  const repos = await resolveWorkspaceRepos(plan.target_repos);
  const singleRepo = isSingleRepoPlan(repos);
  const branch = planBranchName(plan.slug);
  const rootDir = worktreeRootPath(plan.slug);

  // Best-effort cleanup of any orphaned worktree from a prior failed run.
  // We don't error if nothing's there.
  for (const repo of repos) {
    const wtPath = singleRepo ? rootDir : worktreePath(plan.slug, repo.name);
    try {
      gitWorktreeRemove({ repoRoot: repo.root, worktreePath: wtPath });
    } catch {
      // doesn't exist — fine
    }
  }
  await fs.rm(rootDir, { recursive: true, force: true }).catch(() => undefined);

  await fs.mkdir(rootDir, { recursive: true });

  const worktrees: PlanWorktree[] = [];
  const rewrittenRepos: ResolvedWorkspaceRepo[] = [];
  for (const repo of repos) {
    const wtPath = singleRepo ? rootDir : worktreePath(plan.slug, repo.name);
    gitWorktreeAdd({
      repoRoot: repo.root,
      worktreePath: wtPath,
      branch,
      baseBranch: config.dev_branch,
    });
    worktrees.push({
      repo: singleRepo ? null : repo.name,
      path: wtPath,
      branch,
      parentRoot: repo.root,
    });
    rewrittenRepos.push({
      name: repo.name,
      path: singleRepo ? repo.path : repo.name,
      root: wtPath,
    });
  }

  // Copy plan markdown into the worktree at the same relative path the
  // prompt references (`@.lauren/plans/<slug>.md`). `.lauren/` is gitignored
  // so this doesn't leak into the commit.
  const planSrc = planFilePath(plan);
  const planDst = path.join(rootDir, '.lauren', 'plans', `${plan.slug}.md`);
  await fs.mkdir(path.dirname(planDst), { recursive: true });
  await fs.copyFile(planSrc, planDst);

  return { rootCwd: rootDir, rewrittenRepos, worktrees };
}

/**
 * Remove every worktree on the plan row, delete the per-repo `lauren/<slug>`
 * branches, and best-effort blow away the worktree root directory. Safe to
 * call when no worktrees exist (no-op).
 *
 * When `keepBranches` is true, leaves the branches in place so the user can
 * inspect them later (used by github-pr success paths where the remote may
 * still need the local branch around for cleanup ordering).
 *
 * When `requireClean` is true, every existing worktree must be clean before
 * any worktree is removed. This protects cancel-keep paths where uncommitted
 * edits belong to the user until they explicitly resolve them.
 */
export async function cleanupPlanWorktrees(
  plan: Plan,
  opts: { keepBranches?: boolean; requireClean?: boolean } = {},
): Promise<void> {
  const worktrees = plan.worktrees ?? [];
  if (opts.requireClean) {
    const dirtyWorktrees: string[] = [];
    for (const wt of worktrees) {
      try {
        await fs.access(wt.path);
      } catch {
        continue;
      }
      if (workingTreeDirty(wt.path)) {
        dirtyWorktrees.push(displayPath(wt.path));
      }
    }
    if (dirtyWorktrees.length > 0) {
      throw new Error(`worktree(s) must be clean before removal: ${dirtyWorktrees.join(', ')}`);
    }
  }

  const removalFailures: string[] = [];
  for (const wt of worktrees) {
    let removed = false;
    try {
      gitWorktreeRemove({ repoRoot: wt.parentRoot, worktreePath: wt.path });
      removed = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`warning: failed to remove worktree ${displayPath(wt.path)}: ${msg}\n`);
      removalFailures.push(`${displayPath(wt.path)}: ${msg}`);
    }
    if (removed && !opts.keepBranches) {
      try {
        gitDeleteBranch(wt.branch, wt.parentRoot);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`warning: failed to delete branch ${wt.branch}: ${msg}\n`);
      }
    }
  }
  if (removalFailures.length > 0) {
    throw new Error(`failed to remove worktree(s): ${removalFailures.join('; ')}`);
  }
  if (worktrees.length > 0) {
    const root = worktreeRootPath(plan.slug);
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}
