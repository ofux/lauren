import { promises as fs } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import { DEFAULT_CONTEXT, type LaurenContext } from './paths.js';
import {
  migratePlanRecord,
  type Plan,
  PlanNotFound,
  PreparingLocked,
  SCHEMA_VERSION,
  SlugCollision,
  type TodoFile,
} from './types.js';

export class InboxStoreFormatError extends Error {
  readonly path: string;

  constructor(filePath: string, message: string) {
    super(`${filePath}: ${message}`);
    this.name = 'InboxStoreFormatError';
    this.path = filePath;
  }
}

async function ensureLockFile(lockPath: string): Promise<void> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const fd = await fs.open(lockPath, 'a');
  await fd.close();
}

/**
 * FIFO queue of plans awaiting brain placement. The brain daemon drains it
 * into the todo store; nothing else mutates ordering. Mirrors TodoStore's
 * lock + atomic-write pattern but exposes only read/add/find/remove.
 *
 * Inbox plans use status `enqueued` (waiting) or `preparing` (brain is
 * actively running placement). The `preparing` status is set by the brain
 * before invoking claude, so the TUI can distinguish "queued" from
 * "currently being placed" and route cancellation accordingly.
 */
export class InboxStore {
  readonly path: string;
  readonly lockPath: string;

  constructor(opts: { path?: string; lockPath?: string; context?: LaurenContext } = {}) {
    const context = opts.context ?? DEFAULT_CONTEXT;
    this.path = opts.path ?? context.inboxPath;
    this.lockPath = opts.lockPath ?? context.inboxLockPath;
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
      throw new InboxStoreFormatError(this.path, `malformed JSON: ${msg}`);
    }
    if (data.version !== SCHEMA_VERSION) {
      throw new InboxStoreFormatError(
        this.path,
        `schema version ${JSON.stringify(data.version)} not supported (expected ${SCHEMA_VERSION})`,
      );
    }
    return Array.isArray(data.plans) ? data.plans.map((p) => migratePlanRecord(p, 'inbox')) : [];
  }

  private async writeUnlocked(plans: Plan[]): Promise<void> {
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    const data: TodoFile = { version: SCHEMA_VERSION, plans };
    const tmp = path.join(path.dirname(this.path), `.inbox.${process.pid}.${Date.now()}.json.tmp`);
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

  async remove(slug: string, opts: { allowPreparing?: boolean } = {}): Promise<Plan> {
    return this.withLock(async () => {
      const plans = await this.readUnlocked();
      const idx = plans.findIndex((p) => p.slug === slug);
      if (idx === -1) throw new PlanNotFound(slug);
      const plan = plans[idx]!;
      if (plan.status === 'preparing' && !opts.allowPreparing) {
        throw new PreparingLocked(slug);
      }
      plans.splice(idx, 1);
      await this.writeUnlocked(plans);
      return plan;
    });
  }

  async update(
    slug: string,
    fields: Partial<Omit<Plan, 'slug'>>,
    opts: { allowPreparing?: boolean } = {},
  ): Promise<Plan> {
    return this.withLock(async () => {
      const plans = await this.readUnlocked();
      const idx = plans.findIndex((p) => p.slug === slug);
      if (idx === -1) throw new PlanNotFound(slug);
      const plan = plans[idx]!;
      if (plan.status === 'preparing' && !opts.allowPreparing) {
        throw new PreparingLocked(slug);
      }
      const updated: Plan = { ...plan, ...fields, slug: plan.slug };
      plans[idx] = updated;
      await this.writeUnlocked(plans);
      return updated;
    });
  }
}
