import path from 'node:path';

export const REPO = process.cwd();

export const LAUREN_DIR = path.join(REPO, '.lauren');
export const LOG_ROOT = path.join(LAUREN_DIR, 'logs');
export const PLANS_DIR = path.join(LAUREN_DIR, 'plans');
export const TODO_PATH = path.join(LAUREN_DIR, 'todo.json');
export const LOCK_PATH = path.join(LAUREN_DIR, 'todo.json.lock');

export const DOCS_DIR = path.join(REPO, 'docs');
export const PRD_PATH = path.join(DOCS_DIR, 'PRD.md');
export const ARCH_PATH = path.join(DOCS_DIR, 'ARCHITECTURE.md');
export const TESTING_PATH = path.join(DOCS_DIR, 'TESTING.md');

export function displayPath(p: string): string {
  const rel = path.relative(REPO, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return p;
  return rel;
}

export function resolvePlanPath(s: string): string {
  return path.isAbsolute(s) ? path.resolve(s) : path.resolve(REPO, s);
}
