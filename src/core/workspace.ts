import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DEFAULT_CONTEXT, displayPath, type LaurenContext } from './paths.js';

export interface WorkspaceRepoConfig {
  name: string;
  path: string;
}

export interface WorkspaceConfig {
  version: 1;
  repos: WorkspaceRepoConfig[];
}

export interface ResolvedWorkspaceRepo {
  name: string;
  path: string;
  root: string;
}

export class WorkspaceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceConfigError';
  }
}

export function workspaceConfigPath(context: LaurenContext = DEFAULT_CONTEXT): string {
  return path.join(context.laurenDir, 'workspace.json');
}

function isPathInside(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceConfigError(`${label} must be an object`);
  }
}

function parseWorkspaceConfig(raw: unknown, configPath: string): WorkspaceConfig {
  assertObject(raw, displayPath(configPath));
  if (raw.version !== 1) {
    throw new WorkspaceConfigError(
      `${displayPath(configPath)}: unsupported version ${JSON.stringify(raw.version)}`,
    );
  }
  if (!Array.isArray(raw.repos)) {
    throw new WorkspaceConfigError(`${displayPath(configPath)}: repos must be an array`);
  }

  const repos: WorkspaceRepoConfig[] = [];
  const seen = new Set<string>();
  for (const [idx, item] of raw.repos.entries()) {
    assertObject(item, `${displayPath(configPath)}: repos[${idx}]`);
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const repoPath = typeof item.path === 'string' ? item.path.trim() : '';
    if (!name) {
      throw new WorkspaceConfigError(`${displayPath(configPath)}: repos[${idx}].name is required`);
    }
    if (!repoPath) {
      throw new WorkspaceConfigError(`${displayPath(configPath)}: repos[${idx}].path is required`);
    }
    if (seen.has(name)) {
      throw new WorkspaceConfigError(`${displayPath(configPath)}: duplicate repo name '${name}'`);
    }
    seen.add(name);
    repos.push({ name, path: repoPath });
  }
  if (repos.length === 0) {
    throw new WorkspaceConfigError(`${displayPath(configPath)}: repos must not be empty`);
  }
  return { version: 1, repos };
}

export async function readWorkspaceConfig(
  context: LaurenContext = DEFAULT_CONTEXT,
): Promise<WorkspaceConfig | null> {
  const configPath = workspaceConfigPath(context);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkspaceConfigError(`${displayPath(configPath)}: malformed JSON: ${msg}`);
  }
  return parseWorkspaceConfig(parsed, configPath);
}

function resolveConfiguredRepos(
  config: WorkspaceConfig,
  context: LaurenContext,
): ResolvedWorkspaceRepo[] {
  const seenRoots = new Map<string, string>();
  return config.repos.map((repo) => {
    const root = path.resolve(context.repo, repo.path);
    if (!isPathInside(context.repo, root)) {
      throw new WorkspaceConfigError(
        `.lauren/workspace.json: repo '${repo.name}' path must stay inside ${displayPath(
          context.repo,
          context,
        )}`,
      );
    }
    const priorName = seenRoots.get(root);
    if (priorName !== undefined) {
      throw new WorkspaceConfigError(
        `.lauren/workspace.json: repo '${repo.name}' resolves to the same path as repo '${priorName}'`,
      );
    }
    seenRoots.set(root, repo.name);
    return {
      name: repo.name,
      path: path.relative(context.repo, root) || '.',
      root,
    };
  });
}

async function assertRepoUsable(
  repo: ResolvedWorkspaceRepo,
  context: LaurenContext,
): Promise<void> {
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(repo.root);
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorkspaceConfigError(
        `.lauren/workspace.json: repo '${repo.name}' path '${repo.path}' does not exist`,
      );
    }
    throw err;
  }
  if (!stats.isDirectory()) {
    throw new WorkspaceConfigError(
      `.lauren/workspace.json: repo '${repo.name}' path '${repo.path}' is not a directory`,
    );
  }
  try {
    // .git is a directory in normal repos and a file in worktrees/submodules —
    // existence is sufficient. We accept either rather than spawning git here.
    await fs.stat(path.join(repo.root, '.git'));
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorkspaceConfigError(
        `.lauren/workspace.json: repo '${repo.name}' at '${displayPath(
          repo.root,
          context,
        )}' is not a git repository (no .git entry)`,
      );
    }
    throw err;
  }
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    // `.git` is a directory in normal repos and a file in worktrees/submodules.
    await fs.stat(path.join(dir, '.git'));
    return true;
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function discoverSubRepos(root: string): Promise<ResolvedWorkspaceRepo[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  const found: ResolvedWorkspaceRepo[] = [];
  for (const name of candidates) {
    const repoRoot = path.join(root, name);
    if (await isGitRepo(repoRoot)) {
      found.push({ name, path: name, root: repoRoot });
    }
  }
  return found;
}

export async function resolveWorkspaceRepos(
  targets: readonly string[] = [],
  context: LaurenContext = DEFAULT_CONTEXT,
): Promise<ResolvedWorkspaceRepo[]> {
  const config = await readWorkspaceConfig(context);
  if (config === null) {
    if (targets.length > 0) {
      throw new WorkspaceConfigError(
        `--repo requires ${displayPath(workspaceConfigPath(context), context)}`,
      );
    }
    if (await isGitRepo(context.repo)) {
      return [{ name: path.basename(context.repo), path: '.', root: context.repo }];
    }
    // Not a git repo and no workspace.json — try to auto-discover sub-repos
    // by scanning immediate children for `.git` entries. This is what makes
    // `lauren vibe` work from a parent folder containing several repos
    // without forcing the user to hand-roll a workspace.json.
    const discovered = await discoverSubRepos(context.repo);
    if (discovered.length > 0) return discovered;
    throw new WorkspaceConfigError(
      `${context.repo} is not a git repository and no sub-repositories were found. ` +
        `Run lauren from inside a git repo, or from a parent folder that contains ` +
        `one or more git repos as immediate sub-directories. You can also create ` +
        `${displayPath(workspaceConfigPath(context), context)} to configure repos explicitly.`,
    );
  }

  const repos = resolveConfiguredRepos(config, context);
  await Promise.all(repos.map((repo) => assertRepoUsable(repo, context)));
  if (targets.length === 0) return repos;

  const byName = new Map(repos.map((repo) => [repo.name, repo]));
  const byPath = new Map(repos.map((repo) => [repo.path, repo]));
  const resolved: ResolvedWorkspaceRepo[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const repo = byName.get(target) ?? byPath.get(target);
    if (!repo) {
      throw new WorkspaceConfigError(
        `unknown repo '${target}' in ${displayPath(workspaceConfigPath(context), context)}`,
      );
    }
    if (seen.has(repo.name)) continue;
    seen.add(repo.name);
    resolved.push(repo);
  }
  return resolved;
}

export function formatRepoList(repos: readonly ResolvedWorkspaceRepo[]): string {
  return repos.map((repo) => `${repo.name} (${repo.path})`).join(', ');
}
