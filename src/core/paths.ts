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
  todoPath: string;
  lockPath: string;
  vibeLockPath: string;
  vibePidPath: string;
  inboxPath: string;
  inboxLockPath: string;
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
    todoPath: path.join(laurenDir, 'todo.json'),
    lockPath: path.join(laurenDir, 'todo.json.lock'),
    vibeLockPath: path.join(laurenDir, 'vibe.lock'),
    vibePidPath: path.join(laurenDir, 'vibe.pid'),
    inboxPath: path.join(laurenDir, 'inbox.json'),
    inboxLockPath: path.join(laurenDir, 'inbox.json.lock'),
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
export const TODO_PATH = DEFAULT_CONTEXT.todoPath;
export const LOCK_PATH = DEFAULT_CONTEXT.lockPath;
export const VIBE_LOCK_PATH = DEFAULT_CONTEXT.vibeLockPath;
export const VIBE_PID_PATH = DEFAULT_CONTEXT.vibePidPath;
export const INBOX_PATH = DEFAULT_CONTEXT.inboxPath;
export const INBOX_LOCK_PATH = DEFAULT_CONTEXT.inboxLockPath;

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
