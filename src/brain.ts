import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TodoStore } from './core/store.js';
import { InProgressLocked, type Plan, PlanNotFound, planFilePath } from './core/types.js';
import { BRAIN_ORGANIZE_PROMPT, BRAIN_PLACE_PROMPT } from './lauren-prompts.js';
import { runClaudeOneshotJson } from './proc/claude.js';

interface PendingWithBody {
  plan: Plan;
  body: string;
}

interface PlaceDecision {
  decision?: 'insert' | 'merge';
  position?: unknown;
  merge_into?: unknown;
  merged_title?: unknown;
  merged_markdown?: unknown;
  reasoning?: unknown;
}

interface OrganizeOp {
  op?: 'merge' | 'reorder';
  into?: unknown;
  from?: unknown;
  merged_title?: unknown;
  merged_markdown?: unknown;
  order?: unknown;
}

interface OrganizeDecision {
  operations?: OrganizeOp[];
  reasoning?: unknown;
}

async function readPendingWithBodies(store: TodoStore): Promise<PendingWithBody[]> {
  const out: PendingWithBody[] = [];
  for (const p of await store.read()) {
    if (p.status !== 'pending') continue;
    let body: string;
    try {
      body = await fs.readFile(planFilePath(p), 'utf8');
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        body = '(plan file missing)';
      } else {
        throw err;
      }
    }
    out.push({ plan: p, body });
  }
  return out;
}

function formatPendingForBrain(pending: PendingWithBody[]): string {
  if (pending.length === 0) return '(queue is empty)';
  return pending
    .map(
      ({ plan, body }, i) =>
        `### Pending plan #${i} — slug: \`${plan.slug}\` — title: ${plan.title}\n\n${body}`,
    )
    .join('\n\n---\n\n');
}

export async function brainPlacePlan(
  store: TodoStore,
  newPlan: Plan,
  newBody: string,
): Promise<PlaceDecision> {
  const pending = await readPendingWithBodies(store);
  const others = pending.filter((p) => p.plan.slug !== newPlan.slug);
  const userPrompt =
    `## Current queue (pending only, in order)\n\n` +
    `${formatPendingForBrain(others)}\n\n` +
    `---\n\n` +
    `## New plan just registered (slug: \`${newPlan.slug}\`, title: ${newPlan.title})\n\n` +
    `${newBody}\n\n` +
    `Decide: insert at a position among the ${others.length} pending plan(s), ` +
    `or merge into one of them. Return the JSON object.`;
  const result = await runClaudeOneshotJson({
    systemPrompt: BRAIN_PLACE_PROMPT,
    userPrompt,
  });
  return result as PlaceDecision;
}

export async function brainOrganizeQueue(
  store: TodoStore,
): Promise<{ decision: OrganizeDecision; pending: PendingWithBody[] }> {
  const pending = await readPendingWithBodies(store);
  const userPrompt =
    `## Pending queue (in order)\n\n` +
    `${formatPendingForBrain(pending)}\n\n` +
    `Re-think the queue and return the JSON object.`;
  const result = await runClaudeOneshotJson({
    systemPrompt: BRAIN_ORGANIZE_PROMPT,
    userPrompt,
  });
  return { decision: result as OrganizeDecision, pending };
}

async function fallbackPlaceAtBack(store: TodoStore, newPlan: Plan, msg: string): Promise<string> {
  try {
    await store.move(newPlan.slug, { toBack: true });
  } catch (err) {
    if (!(err instanceof PlanNotFound) && !(err instanceof InProgressLocked)) {
      throw err;
    }
  }
  return msg;
}

export async function applyPlaceDecision(
  store: TodoStore,
  newPlan: Plan,
  decision: PlaceDecision,
): Promise<string> {
  const reasoning = typeof decision.reasoning === 'string' ? decision.reasoning.trim() : '';

  if (decision.decision === 'merge') {
    const targetSlug = typeof decision.merge_into === 'string' ? decision.merge_into : '';
    const mergedMd = typeof decision.merged_markdown === 'string' ? decision.merged_markdown : '';
    const mergedTitle = typeof decision.merged_title === 'string' ? decision.merged_title : '';
    if (!targetSlug || !mergedMd || !mergedTitle) {
      return fallbackPlaceAtBack(
        store,
        newPlan,
        `merge decision missing fields; left '${newPlan.slug}' at end of queue`,
      );
    }
    const target = await store.find(targetSlug);
    if (target === null) {
      return fallbackPlaceAtBack(
        store,
        newPlan,
        `merge target '${targetSlug}' not found; left '${newPlan.slug}' at end of queue`,
      );
    }
    if (target.status !== 'pending') {
      return fallbackPlaceAtBack(
        store,
        newPlan,
        `merge target '${targetSlug}' is ${target.status}; left '${newPlan.slug}' at end of queue`,
      );
    }
    const targetPath = planFilePath(target);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, mergedMd, 'utf8');
    try {
      await store.update(targetSlug, { title: mergedTitle });
    } catch (err) {
      if (err instanceof InProgressLocked) {
        return fallbackPlaceAtBack(
          store,
          newPlan,
          `merge target '${targetSlug}' became in_progress; left '${newPlan.slug}' at end of queue`,
        );
      }
      throw err;
    }
    try {
      const removed = await store.remove(newPlan.slug);
      try {
        await fs.unlink(planFilePath(removed));
      } catch (err) {
        if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }
    } catch (err) {
      if (!(err instanceof PlanNotFound) && !(err instanceof InProgressLocked)) {
        throw err;
      }
    }
    return `merged '${newPlan.slug}' into '${targetSlug}'${reasoning ? `: ${reasoning}` : ''}`;
  }

  // decision == insert (or unknown — treat as insert)
  let position = 0;
  const rawPos = decision.position;
  if (typeof rawPos === 'number' && Number.isFinite(rawPos)) {
    position = Math.max(0, Math.floor(rawPos));
  } else if (typeof rawPos === 'string') {
    const n = Number.parseInt(rawPos, 10);
    if (Number.isFinite(n)) position = Math.max(0, n);
  }

  const plans = await store.read();
  const pendingOthers = plans.filter((p) => p.status === 'pending' && p.slug !== newPlan.slug);
  let where: string;
  try {
    if (position >= pendingOthers.length) {
      await store.move(newPlan.slug, { toBack: true });
      where = 'end of queue';
    } else {
      const beforeSlug = pendingOthers[position]!.slug;
      await store.move(newPlan.slug, { before: beforeSlug });
      where = `position ${position} (before '${beforeSlug}')`;
    }
  } catch (err) {
    if (!(err instanceof PlanNotFound) && !(err instanceof InProgressLocked)) {
      throw err;
    }
    where = 'end of queue (move failed)';
  }
  return `placed '${newPlan.slug}' at ${where}${reasoning ? `: ${reasoning}` : ''}`;
}

export function summarizeOrganizeDecision(decision: OrganizeDecision): string[] {
  const ops = decision.operations ?? [];
  if (ops.length === 0) return ['(no operations — queue is fine as-is)'];
  const out: string[] = [];
  for (const op of ops) {
    if (op.op === 'merge') {
      out.push(
        `merge: '${String(op.from)}' → '${String(op.into)}' ` +
          `(new title: ${JSON.stringify(op.merged_title)})`,
      );
    } else if (op.op === 'reorder') {
      const order = Array.isArray(op.order) ? (op.order as unknown[]).map(String) : [];
      out.push(`reorder: ${order.join(' → ')}`);
    } else {
      out.push(`unknown op: ${JSON.stringify(op)}`);
    }
  }
  return out;
}

export async function applyOrganizeDecision(
  store: TodoStore,
  decision: OrganizeDecision,
): Promise<string[]> {
  const summary: string[] = [];
  for (const op of decision.operations ?? []) {
    if (op.op === 'merge') {
      const into = typeof op.into === 'string' ? op.into : '';
      const fromSlug = typeof op.from === 'string' ? op.from : '';
      const mergedMd = typeof op.merged_markdown === 'string' ? op.merged_markdown : '';
      const mergedTitle = typeof op.merged_title === 'string' ? op.merged_title : '';
      if (!into || !fromSlug || !mergedMd || !mergedTitle) {
        summary.push(`  skip merge (missing fields): ${JSON.stringify(op)}`);
        continue;
      }
      const target = await store.find(into);
      const fromPlan = await store.find(fromSlug);
      if (target === null || fromPlan === null) {
        summary.push(`  skip merge ${fromSlug} → ${into}: slug not found`);
        continue;
      }
      if (target.status !== 'pending' || fromPlan.status !== 'pending') {
        summary.push(`  skip merge ${fromSlug} → ${into}: not both pending`);
        continue;
      }
      const targetPath = planFilePath(target);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, mergedMd, 'utf8');
      try {
        await store.update(into, { title: mergedTitle });
        await store.remove(fromSlug);
        try {
          await fs.unlink(planFilePath(fromPlan));
        } catch (err) {
          if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err;
          }
        }
        summary.push(`  merged '${fromSlug}' → '${into}'`);
      } catch (err) {
        if (err instanceof InProgressLocked) {
          summary.push(`  skip merge ${fromSlug} → ${into}: lock changed mid-apply`);
        } else {
          throw err;
        }
      }
    } else if (op.op === 'reorder') {
      const order = Array.isArray(op.order) ? (op.order as unknown[]).map(String) : [];
      try {
        await store.reorderPending(order);
        summary.push(`  reordered ${order.length} pending plan(s)`);
      } catch (err) {
        if (err instanceof InProgressLocked) {
          summary.push(`  skip reorder: ${err.message}`);
        } else if (err instanceof Error) {
          summary.push(`  skip reorder: ${err.message}`);
        } else {
          throw err;
        }
      }
    } else {
      summary.push(`  skip unknown op: ${String(op.op)}`);
    }
  }
  return summary;
}
