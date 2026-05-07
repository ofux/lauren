import { promises as fs } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import { DEFAULT_CONTEXT, type LaurenContext } from './paths.js';
import type { PrEntry } from './prs.js';
import {
  ImplementingLocked,
  migratePlanRecord,
  type Plan,
  PlanNotFound,
  PlanNotReady,
  PlanSelfMerge,
  SCHEMA_VERSION,
  SlugCollision,
  type TodoFile,
} from './types.js';

interface MoveOptions {
  before?: string;
  toFront?: boolean;
  toBack?: boolean;
  allowImplementing?: boolean;
}

interface MergeBodyWrite {
  rollback?: () => Promise<void>;
  finalize?: () => Promise<void>;
}

function mergeTargetRepos(a: readonly string[], b: readonly string[]): string[] {
  if (a.length === 0 || b.length === 0) return [];
  return [...new Set([...a, ...b])];
}

export class TodoStoreFormatError extends Error {
  readonly path: string;

  constructor(filePath: string, message: string) {
    super(`${filePath}: ${message}`);
    this.name = 'TodoStoreFormatError';
    this.path = filePath;
  }
}

async function ensureLockFile(lockPath: string): Promise<void> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const fd = await fs.open(lockPath, 'a');
  await fd.close();
}

export class TodoStore {
  readonly path: string;
  readonly lockPath: string;

  constructor(opts: { path?: string; lockPath?: string; context?: LaurenContext } = {}) {
    const context = opts.context ?? DEFAULT_CONTEXT;
    this.path = opts.path ?? context.todoPath;
    this.lockPath = opts.lockPath ?? context.lockPath;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await ensureLockFile(this.lockPath);
    const release = await lockfile.lock(this.lockPath, {
      retries: { retries: 50, factor: 1.2, minTimeout: 20, maxTimeout: 200 },
      stale: 30_000,
      realpath: false,
    });
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  private async readUnlocked(): Promise<Plan[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, 'utf8');
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
    let data: TodoFile;
    try {
      data = JSON.parse(raw) as TodoFile;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new TodoStoreFormatError(this.path, `malformed JSON: ${msg}`);
    }
    if (data.version !== SCHEMA_VERSION) {
      throw new TodoStoreFormatError(
        this.path,
        `schema version ${JSON.stringify(data.version)} not supported (expected ${SCHEMA_VERSION})`,
      );
    }
    return Array.isArray(data.plans) ? data.plans.map((p) => migratePlanRecord(p, 'todo')) : [];
  }

  private async writeUnlocked(plans: Plan[]): Promise<void> {
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    const data: TodoFile = { version: SCHEMA_VERSION, plans };
    const tmp = path.join(path.dirname(this.path), `.todo.${process.pid}.${Date.now()}.json.tmp`);
    const body = `${JSON.stringify(data, null, 2)}\n`;
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, this.path);
  }

  async read(): Promise<Plan[]> {
    return this.withLock(() => this.readUnlocked());
  }

  async find(slug: string): Promise<Plan | null> {
    return this.withLock(async () => {
      const plans = await this.readUnlocked();
      return plans.find((p) => p.slug === slug) ?? null;
    });
  }

  async add(plan: Plan): Promise<void> {
    await this.withLock(async () => {
      const plans = await this.readUnlocked();
      if (plans.some((p) => p.slug === plan.slug)) {
        throw new SlugCollision(plan.slug);
      }
      plans.push(plan);
      await this.writeUnlocked(plans);
    });
  }

  async remove(slug: string, opts: { allowImplementing?: boolean } = {}): Promise<Plan> {
    return this.withLock(async () => {
      const plans = await this.readUnlocked();
      const idx = plans.findIndex((p) => p.slug === slug);
      if (idx === -1) throw new PlanNotFound(slug);
      const plan = plans[idx]!;
      if (plan.status === 'implementing' && !opts.allowImplementing) {
        throw new ImplementingLocked(slug);
      }
      plans.splice(idx, 1);
      await this.writeUnlocked(plans);
      return plan;
    });
  }

  async update(
    slug: string,
    fields: Partial<Omit<Plan, 'slug'>>,
    opts: { allowImplementing?: boolean } = {},
  ): Promise<Plan> {
    return this.withLock(async () => {
      const plans = await this.readUnlocked();
      const idx = plans.findIndex((p) => p.slug === slug);
      if (idx === -1) throw new PlanNotFound(slug);
      const plan = plans[idx]!;
      if (plan.status === 'implementing' && !opts.allowImplementing) {
        throw new ImplementingLocked(slug);
      }
      const updated: Plan = { ...plan, ...fields, slug: plan.slug };
      plans[idx] = updated;
      await this.writeUnlocked(plans);
      return updated;
    });
  }

  /**
   * Reorder plans currently in `ready` status. Other statuses keep their
   * positions. Called by the brain when the AI returns an organize decision.
   */
  async reorderReady(order: string[]): Promise<void> {
    await this.withLock(async () => {
      const plans = await this.readUnlocked();
      const readySlugs = plans.filter((p) => p.status === 'ready').map((p) => p.slug);
      const orderSet = new Set(order);
      const readySet = new Set(readySlugs);
      const missing = readySlugs.filter((s) => !orderSet.has(s)).sort();
      const extra = order.filter((s) => !readySet.has(s)).sort();
      if (missing.length !== 0 || extra.length !== 0 || order.length !== readySlugs.length) {
        throw new Error(
          `reorder mismatch: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`,
        );
      }
      const slugToPlan = new Map<string, Plan>();
      for (const p of plans) {
        if (p.status === 'ready') slugToPlan.set(p.slug, p);
      }
      const queue = order.map((s) => slugToPlan.get(s)!);
      const result: Plan[] = [];
      let i = 0;
      for (const p of plans) {
        if (p.status === 'ready') {
          result.push(queue[i++]!);
        } else {
          result.push(p);
        }
      }
      await this.writeUnlocked(result);
    });
  }

  /**
   * Atomically merge `fromSlug` into `targetSlug`: both must be ready at
   * lock acquisition. Inside the lock, the caller's `bodyWriter` runs (it
   * typically rewrites the target's plan file on disk), the target's title
   * is updated, and the from-plan is removed from the queue. The on-disk
   * .md for the from-plan is the caller's responsibility to clean up.
   */
  async atomicMerge(args: {
    targetSlug: string;
    fromSlug: string;
    newTitle: string;
    /**
     * Replacement PR list for the target. Pass a function to compute it
     * from the locked-in target state (e.g. reconcile against the target's
     * existing PR statuses); pass an array/null to overwrite directly.
     * Omit to leave the target's PR list unchanged.
     */
    newPrs?: PrEntry[] | null | ((target: Plan) => PrEntry[] | null);
    bodyWriter: (target: Plan) => Promise<MergeBodyWrite | undefined>;
  }): Promise<{ target: Plan; from: Plan }> {
    if (args.targetSlug === args.fromSlug) {
      throw new PlanSelfMerge(args.targetSlug);
    }
    return this.withLock(async () => {
      const plans = await this.readUnlocked();
      const tIdx = plans.findIndex((p) => p.slug === args.targetSlug);
      if (tIdx === -1) throw new PlanNotFound(args.targetSlug);
      const target = plans[tIdx]!;
      if (target.status !== 'ready') throw new PlanNotReady(target.slug, target.status);

      const fIdx = plans.findIndex((p) => p.slug === args.fromSlug);
      if (fIdx === -1) throw new PlanNotFound(args.fromSlug);
      const from = plans[fIdx]!;
      if (from.status !== 'ready') throw new PlanNotReady(from.slug, from.status);

      const bodyWrite = await args.bodyWriter(target);
      const resolvedPrs = typeof args.newPrs === 'function' ? args.newPrs(target) : args.newPrs;
      const updatedTarget: Plan = {
        ...target,
        title: args.newTitle,
        target_repos: mergeTargetRepos(target.target_repos, from.target_repos),
        ...(args.newPrs !== undefined ? { prs: resolvedPrs ?? null } : {}),
      };
      try {
        plans[tIdx] = updatedTarget;
        // Recompute fromIdx in case it shifted (it can't here, since neither
        // splice has happened yet, but be explicit).
        const fIdx2 = plans.findIndex((p) => p.slug === args.fromSlug);
        plans.splice(fIdx2, 1);
        await this.writeUnlocked(plans);
      } catch (err) {
        await bodyWrite?.rollback?.().catch(() => undefined);
        throw err;
      }
      await bodyWrite?.finalize?.();
      return { target: updatedTarget, from };
    });
  }

  async move(slug: string, opts: MoveOptions = {}): Promise<void> {
    await this.withLock(async () => {
      const plans = await this.readUnlocked();
      const idx = plans.findIndex((p) => p.slug === slug);
      if (idx === -1) throw new PlanNotFound(slug);
      const plan = plans[idx]!;
      if (plan.status === 'implementing' && !opts.allowImplementing) {
        throw new ImplementingLocked(slug);
      }
      plans.splice(idx, 1);
      if (opts.toFront) {
        plans.unshift(plan);
      } else if (opts.toBack) {
        plans.push(plan);
      } else if (opts.before !== undefined) {
        const target = plans.findIndex((p) => p.slug === opts.before);
        if (target === -1) {
          throw new PlanNotFound(opts.before);
        }
        plans.splice(target, 0, plan);
      } else {
        plans.splice(idx, 0, plan);
      }
      await this.writeUnlocked(plans);
    });
  }
}
