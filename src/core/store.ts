import { promises as fs } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import { LOCK_PATH, TODO_PATH } from './paths.js';
import {
  InProgressLocked,
  type Plan,
  PlanNotFound,
  SCHEMA_VERSION,
  SlugCollision,
  type TodoFile,
} from './types.js';

interface MoveOptions {
  before?: string;
  toFront?: boolean;
  toBack?: boolean;
  allowInProgress?: boolean;
}

async function ensureLockFile(lockPath: string): Promise<void> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const fd = await fs.open(lockPath, 'a');
  await fd.close();
}

export class TodoStore {
  readonly path: string;
  readonly lockPath: string;

  constructor(opts: { path?: string; lockPath?: string } = {}) {
    this.path = opts.path ?? TODO_PATH;
    this.lockPath = opts.lockPath ?? LOCK_PATH;
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
      process.stderr.write(`error: ${this.path} is malformed JSON: ${msg}\n`);
      process.exit(1);
    }
    if (data.version !== SCHEMA_VERSION) {
      process.stderr.write(
        `error: ${this.path} schema version ${JSON.stringify(data.version)} not supported (expected ${SCHEMA_VERSION})\n`,
      );
      process.exit(1);
    }
    return Array.isArray(data.plans) ? data.plans : [];
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

  async remove(slug: string, opts: { allowInProgress?: boolean } = {}): Promise<Plan> {
    return this.withLock(async () => {
      const plans = await this.readUnlocked();
      const idx = plans.findIndex((p) => p.slug === slug);
      if (idx === -1) throw new PlanNotFound(slug);
      const plan = plans[idx]!;
      if (plan.status === 'in_progress' && !opts.allowInProgress) {
        throw new InProgressLocked(slug);
      }
      plans.splice(idx, 1);
      await this.writeUnlocked(plans);
      return plan;
    });
  }

  async update(
    slug: string,
    fields: Partial<Omit<Plan, 'slug'>>,
    opts: { allowInProgress?: boolean } = {},
  ): Promise<Plan> {
    return this.withLock(async () => {
      const plans = await this.readUnlocked();
      const idx = plans.findIndex((p) => p.slug === slug);
      if (idx === -1) throw new PlanNotFound(slug);
      const plan = plans[idx]!;
      if (plan.status === 'in_progress' && !opts.allowInProgress) {
        throw new InProgressLocked(slug);
      }
      const updated: Plan = { ...plan, ...fields, slug: plan.slug };
      plans[idx] = updated;
      await this.writeUnlocked(plans);
      return updated;
    });
  }

  async reorderPending(order: string[]): Promise<void> {
    await this.withLock(async () => {
      const plans = await this.readUnlocked();
      const pendingSlugs = plans.filter((p) => p.status === 'pending').map((p) => p.slug);
      const orderSet = new Set(order);
      const pendingSet = new Set(pendingSlugs);
      const missing = pendingSlugs.filter((s) => !orderSet.has(s)).sort();
      const extra = order.filter((s) => !pendingSet.has(s)).sort();
      if (missing.length !== 0 || extra.length !== 0 || order.length !== pendingSlugs.length) {
        throw new Error(
          `reorder mismatch: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`,
        );
      }
      const slugToPlan = new Map<string, Plan>();
      for (const p of plans) {
        if (p.status === 'pending') slugToPlan.set(p.slug, p);
      }
      const queue = order.map((s) => slugToPlan.get(s)!);
      const result: Plan[] = [];
      let i = 0;
      for (const p of plans) {
        if (p.status === 'pending') {
          result.push(queue[i++]!);
        } else {
          result.push(p);
        }
      }
      await this.writeUnlocked(result);
    });
  }

  async move(slug: string, opts: MoveOptions = {}): Promise<void> {
    await this.withLock(async () => {
      const plans = await this.readUnlocked();
      const idx = plans.findIndex((p) => p.slug === slug);
      if (idx === -1) throw new PlanNotFound(slug);
      const plan = plans[idx]!;
      if (plan.status === 'in_progress' && !opts.allowInProgress) {
        throw new InProgressLocked(slug);
      }
      plans.splice(idx, 1);
      if (opts.toFront) {
        plans.unshift(plan);
      } else if (opts.toBack) {
        plans.push(plan);
      } else if (opts.before !== undefined) {
        const target = plans.findIndex((p) => p.slug === opts.before);
        if (target === -1) {
          plans.splice(idx, 0, plan);
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
