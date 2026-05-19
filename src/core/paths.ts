import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function resolveRepoRoot(cwd: string = process.cwd()): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  });
  if (r.status === 0) {
    const root = r.stdout.trim();
    if (root) return path.resolve(root);
  }
  return path.resolve(cwd);
}

export interface LaurenContext {
  repo: string;
  laurenDir: string;
  logRoot: string;
  plansDir: string;
  notesDir: string;
  worktreesRoot: string;
  configPath: string;
  plansStatePath: string;
  plansStateLockPath: string;
  vibeLockPath: string;
  vibePidPath: string;
  docsDir: string;
  prdPath: string;
  archPath: string;
  testingPath: string;
}

export function createLaurenContext(cwd: string = process.cwd()): LaurenContext {
  const repo = resolveRepoRoot(cwd);
  const laurenDir = path.join(repo, '.lauren');
  const docsDir = path.join(repo, 'docs');
  return {
    repo,
    laurenDir,
    logRoot: path.join(laurenDir, 'logs'),
    plansDir: path.join(laurenDir, 'plans'),
    notesDir: path.join(laurenDir, 'notes'),
    worktreesRoot: path.join(laurenDir, 'worktrees'),
    configPath: path.join(laurenDir, 'config.json'),
    plansStatePath: path.join(laurenDir, 'plans.json'),
    plansStateLockPath: path.join(laurenDir, 'plans.json.lock'),
    vibeLockPath: path.join(laurenDir, 'vibe.lock'),
    vibePidPath: path.join(laurenDir, 'vibe.pid'),
    docsDir,
    prdPath: path.join(docsDir, 'PRD.md'),
    archPath: path.join(docsDir, 'ARCHITECTURE.md'),
    testingPath: path.join(docsDir, 'TESTING.md'),
  };
}

export const DEFAULT_CONTEXT = createLaurenContext();

export const REPO = DEFAULT_CONTEXT.repo;

export const LAUREN_DIR = DEFAULT_CONTEXT.laurenDir;
export const LOG_ROOT = DEFAULT_CONTEXT.logRoot;
export const PLANS_DIR = DEFAULT_CONTEXT.plansDir;
export const NOTES_DIR = DEFAULT_CONTEXT.notesDir;
export const WORKTREES_ROOT = DEFAULT_CONTEXT.worktreesRoot;
export const CONFIG_PATH = DEFAULT_CONTEXT.configPath;
export const VIBE_LOCK_PATH = DEFAULT_CONTEXT.vibeLockPath;
export const VIBE_PID_PATH = DEFAULT_CONTEXT.vibePidPath;

/**
 * Root directory under which all worktrees for a given plan live.
 * For single-repo plans, the worktree is checked out directly at this path.
 * For multi-repo plans, each sub-repo's worktree is `<root>/<repo-name>/`.
 */
export function worktreeRootPath(slug: string, context: LaurenContext = DEFAULT_CONTEXT): string {
  return path.join(context.worktreesRoot, slug);
}

/**
 * Path to a specific repo's worktree within a plan's worktree root.
 * Pass `null` for `repoName` for the single-repo case (worktree IS the
 * root). Pass the repo name for multi-repo (worktree is a child dir).
 */
export function worktreePath(
  slug: string,
  repoName: string | null,
  context: LaurenContext = DEFAULT_CONTEXT,
): string {
  const root = worktreeRootPath(slug, context);
  return repoName === null ? root : path.join(root, repoName);
}

export const DOCS_DIR = DEFAULT_CONTEXT.docsDir;
export const PRD_PATH = DEFAULT_CONTEXT.prdPath;
export const ARCH_PATH = DEFAULT_CONTEXT.archPath;
export const TESTING_PATH = DEFAULT_CONTEXT.testingPath;

export function displayPath(p: string, context: LaurenContext = DEFAULT_CONTEXT): string {
  const rel = path.relative(context.repo, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return p;
  return rel;
}

export function resolvePlanPath(s: string, context: LaurenContext = DEFAULT_CONTEXT): string {
  return path.isAbsolute(s) ? path.resolve(s) : path.resolve(context.repo, s);
}

function isPathInside(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function assertPlanPathInsideLaurenPlans(
  s: string,
  context: LaurenContext = DEFAULT_CONTEXT,
): string {
  const resolved = resolvePlanPath(s, context);
  if (!isPathInside(context.plansDir, resolved) || path.extname(resolved) !== '.md') {
    throw new Error(
      `plan path must be a .md file under ${displayPath(context.plansDir, context)}: ${displayPath(
        resolved,
        context,
      )}`,
    );
  }
  return resolved;
}

export function normalizePlanPath(s: string, context: LaurenContext = DEFAULT_CONTEXT): string {
  const resolved = assertPlanPathInsideLaurenPlans(s, context);
  return path.relative(context.repo, resolved);
}

export function resolvePlanSidecarPath(
  s: string,
  planPath: string,
  context: LaurenContext = DEFAULT_CONTEXT,
): string {
  const planAbs = assertPlanPathInsideLaurenPlans(planPath, context);
  const planDir = path.dirname(planAbs);
  const resolved = path.isAbsolute(s) ? path.resolve(s) : path.resolve(planDir, s);
  if (!isPathInside(context.plansDir, resolved) || path.dirname(resolved) !== planDir) {
    throw new Error(
      `sidecar path must be next to ${displayPath(planAbs, context)} under ${displayPath(
        context.plansDir,
        context,
      )}: ${displayPath(resolved, context)}`,
    );
  }
  return resolved;
}
