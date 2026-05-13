import { promises as fs } from 'node:fs';
import path from 'node:path';
import { type CheckpointEntry, reconcileCheckpoints } from './core/checkpoints.js';
import { REPO } from './core/paths.js';
import { materializeSteps, parseCheckpoints } from './core/steps.js';
import type { PlanStore } from './core/store.js';
import {
  ImplementingLocked,
  type Plan,
  PlanNotFound,
  PlanNotReady,
  PlanSelfMerge,
  planFilePath,
} from './core/types.js';
import { BRAIN_ORGANIZE_PROMPT, BRAIN_PLACE_PROMPT } from './lauren-prompts.js';
import { runClaudeOneshotJson } from './proc/claude.js';
import { parsePlanFrontmatter } from './util/planFrontmatter.js';

/**
 * Re-parse checkpoint sections from rewritten plan markdown and reconcile
 * with the target's stored checkpoint list, so brain merges don't drop
 * previously-acknowledged checkpoints. Resolves each checkpoint's link
 * target to a repo-relative `html_path` (same convention as `_register`).
 * Parse errors (missing link, multiple checkpoints in single-unit) are
 * tolerated here — the merge already passed `_register` validation upstream
 * for both inputs, so any error from the merged markdown means the brain
 * produced malformed output; we drop the offending entries silently rather
 * than failing the merge.
 */
function reconcileCheckpointsForMerge(target: Plan, mergedMarkdown: string): CheckpointEntry[] {
  const parsed = parseCheckpoints(mergedMarkdown);
  const targetDir = path.dirname(planFilePath(target));
  const resolved = parsed.checkpoints.map((cp) => {
    const abs = path.isAbsolute(cp.html_path)
      ? cp.html_path
      : path.resolve(targetDir, cp.html_path);
    return { ...cp, html_path: path.relative(REPO, abs) };
  });
  return reconcileCheckpoints(resolved, target.checkpoints ?? null);
}

interface ReadySummary {
  plan: Plan;
  description: string;
  fromFallback: boolean;
}

interface PlaceInsertDecision {
  kind: 'insert';
  position: number;
  reasoning: string;
}

interface PlaceMergeDecision {
  kind: 'merge';
  targetSlug: string;
  mergedTitle: string;
  mergedMarkdown: string;
  reasoning: string;
}

interface InvalidPlaceDecision {
  kind: 'invalid';
  message: string;
}

type PlaceDecision = PlaceInsertDecision | PlaceMergeDecision | InvalidPlaceDecision;

interface OrganizeMergeOp {
  kind: 'merge';
  into: string;
  fromSlug: string;
  mergedTitle: string;
  mergedMarkdown: string;
}

interface OrganizeReorderOp {
  kind: 'reorder';
  order: string[];
}

interface InvalidOrganizeOp {
  kind: 'invalid';
  op: string;
  message: string;
}

type OrganizeDecisionOp = OrganizeMergeOp | OrganizeReorderOp | InvalidOrganizeOp;

interface OrganizeDecision {
  operations: OrganizeDecisionOp[];
  reasoning: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function summarizeBody(raw: string): { description: string; fromFallback: boolean } {
  const { frontmatter, body } = parsePlanFrontmatter(raw);
  if (frontmatter && frontmatter.description.trim() !== '') {
    return { description: frontmatter.description, fromFallback: false };
  }
  const fallbackSrc = frontmatter ? body : raw;
  const lines = fallbackSrc
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .slice(0, 10);
  const excerpt = lines.length > 0 ? lines.join('\n') : '(plan body is empty)';
  return {
    description: `(no frontmatter — fallback excerpt)\n${excerpt}`,
    fromFallback: true,
  };
}

export async function readReadySummaries(store: PlanStore): Promise<ReadySummary[]> {
  const out: ReadySummary[] = [];
  for (const p of await store.read()) {
    if (p.status !== 'ready') continue;
    let raw: string;
    try {
      raw = await fs.readFile(planFilePath(p), 'utf8');
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        out.push({ plan: p, description: '(plan file missing)', fromFallback: true });
        continue;
      }
      throw err;
    }
    const { description, fromFallback } = summarizeBody(raw);
    out.push({ plan: p, description, fromFallback });
  }
  return out;
}

export function formatReadyForBrain(ready: ReadySummary[]): string {
  if (ready.length === 0) return '(queue is empty)';
  return ready
    .map(
      ({ plan, description }, i) =>
        `### Ready plan #${i} — slug: \`${plan.slug}\` — title: ${plan.title} — path: \`${plan.path}\`\n\n${description}`,
    )
    .join('\n\n---\n\n');
}

async function replacePlanFileWithRollback(
  targetPath: string,
  body: string,
): Promise<{ rollback: () => Promise<void>; finalize: () => Promise<void> }> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const suffix = `${process.pid}.${Date.now()}`;
  const tmpPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${suffix}.tmp`,
  );
  const backupPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${suffix}.bak`,
  );
  let hasBackup = false;
  let replaced = false;

  try {
    await fs.writeFile(tmpPath, body, 'utf8');
    try {
      await fs.rename(targetPath, backupPath);
      hasBackup = true;
    } catch (err) {
      if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
    await fs.rename(tmpPath, targetPath);
    replaced = true;
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    if (hasBackup && !replaced) {
      await fs.rename(backupPath, targetPath).catch(() => undefined);
    }
    throw err;
  }

  return {
    rollback: async () => {
      await fs.rm(targetPath, { force: true });
      if (hasBackup) await fs.rename(backupPath, targetPath);
    },
    finalize: async () => {
      await fs.rm(backupPath, { force: true });
    },
  };
}

export async function brainPlacePlan(
  store: PlanStore,
  newPlan: Plan,
  newBody: string,
  signal?: AbortSignal,
): Promise<PlaceDecision> {
  const ready = await readReadySummaries(store);
  const others = ready.filter((p) => p.plan.slug !== newPlan.slug);
  const { description: newDescription } = summarizeBody(newBody);
  const newSummary: ReadySummary = {
    plan: newPlan,
    description: newDescription,
    fromFallback: false,
  };
  const userPrompt =
    `## Current queue (ready only, in order)\n\n` +
    `${formatReadyForBrain(others)}\n\n` +
    `---\n\n` +
    `## New plan just registered\n\n` +
    `${formatReadyForBrain([newSummary])}\n\n` +
    `Decide: insert at a position among the ${others.length} ready plan(s), ` +
    `or merge into one of them. Return the JSON object.`;
  const result = await runClaudeOneshotJson({
    systemPrompt: BRAIN_PLACE_PROMPT,
    userPrompt,
    ...(signal !== undefined ? { signal } : {}),
  });
  return parsePlaceDecision(result);
}

export async function brainOrganizeQueue(
  store: PlanStore,
  signal?: AbortSignal,
): Promise<{ decision: OrganizeDecision; ready: ReadySummary[] }> {
  const ready = await readReadySummaries(store);
  const userPrompt =
    `## Ready queue (in order)\n\n` +
    `${formatReadyForBrain(ready)}\n\n` +
    `Re-think the queue and return the JSON object.`;
  const result = await runClaudeOneshotJson({
    systemPrompt: BRAIN_ORGANIZE_PROMPT,
    userPrompt,
    ...(signal !== undefined ? { signal } : {}),
  });
  return { decision: parseOrganizeDecision(result), ready };
}

async function fallbackPlaceAtBack(store: PlanStore, newPlan: Plan, msg: string): Promise<string> {
  try {
    await store.move(newPlan.slug, { toBack: true });
  } catch (err) {
    if (!(err instanceof PlanNotFound) && !(err instanceof ImplementingLocked)) {
      throw err;
    }
  }
  return msg;
}

function parseInsertPosition(rawPos: unknown): number | null {
  const n =
    typeof rawPos === 'number'
      ? rawPos
      : typeof rawPos === 'string' && rawPos.trim() !== ''
        ? Number(rawPos)
        : NaN;
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === 'string' ? value.trim() : '';
}

function parsePlaceDecision(raw: unknown): PlaceDecision {
  if (!isRecord(raw)) {
    return { kind: 'invalid', message: 'unknown brain decision' };
  }
  const reasoning = stringField(raw, 'reasoning');
  if (raw.kind === 'merge') {
    const targetSlug = stringField(raw, 'targetSlug');
    const mergedMarkdown = typeof raw.mergedMarkdown === 'string' ? raw.mergedMarkdown : '';
    const mergedTitle = stringField(raw, 'mergedTitle');
    if (!targetSlug || !mergedMarkdown || !mergedTitle) {
      return { kind: 'invalid', message: 'merge decision missing fields' };
    }
    return { kind: 'merge', targetSlug, mergedTitle, mergedMarkdown, reasoning };
  }
  if (raw.kind === 'insert') {
    const position = parseInsertPosition(raw.position);
    if (position === null) {
      return { kind: 'invalid', message: 'insert decision missing valid position' };
    }
    return { kind: 'insert', position, reasoning };
  }
  if (raw.kind === 'invalid') {
    return { kind: 'invalid', message: stringField(raw, 'message') || 'unknown brain decision' };
  }
  if (raw.decision === 'merge') {
    const targetSlug = stringField(raw, 'merge_into');
    const mergedMarkdown = typeof raw.merged_markdown === 'string' ? raw.merged_markdown : '';
    const mergedTitle = stringField(raw, 'merged_title');
    if (!targetSlug || !mergedMarkdown || !mergedTitle) {
      return { kind: 'invalid', message: 'merge decision missing fields' };
    }
    return { kind: 'merge', targetSlug, mergedTitle, mergedMarkdown, reasoning };
  }
  if (raw.decision === 'insert') {
    const position = parseInsertPosition(raw.position);
    if (position === null) {
      return { kind: 'invalid', message: 'insert decision missing valid position' };
    }
    return { kind: 'insert', position, reasoning };
  }
  return { kind: 'invalid', message: 'unknown brain decision' };
}

function parseOrganizeOp(raw: unknown): OrganizeDecisionOp {
  if (!isRecord(raw)) {
    return { kind: 'invalid', op: 'unknown', message: `skip unknown op: ${String(raw)}` };
  }
  if (raw.kind === 'merge') {
    const into = stringField(raw, 'into');
    const fromSlug = stringField(raw, 'fromSlug');
    const mergedMarkdown = typeof raw.mergedMarkdown === 'string' ? raw.mergedMarkdown : '';
    const mergedTitle = stringField(raw, 'mergedTitle');
    if (!into || !fromSlug || !mergedMarkdown || !mergedTitle) {
      return {
        kind: 'invalid',
        op: 'merge',
        message: `skip merge (missing fields): ${JSON.stringify(raw)}`,
      };
    }
    return { kind: 'merge', into, fromSlug, mergedTitle, mergedMarkdown };
  }
  if (raw.kind === 'reorder') {
    const order = Array.isArray(raw.order) ? raw.order.map(String) : [];
    return { kind: 'reorder', order };
  }
  if (raw.kind === 'invalid') {
    return {
      kind: 'invalid',
      op: stringField(raw, 'op') || 'unknown',
      message: stringField(raw, 'message') || 'skip unknown op: undefined',
    };
  }
  if (raw.op === 'merge') {
    const into = stringField(raw, 'into');
    const fromSlug = stringField(raw, 'from');
    const mergedMarkdown = typeof raw.merged_markdown === 'string' ? raw.merged_markdown : '';
    const mergedTitle = stringField(raw, 'merged_title');
    if (!into || !fromSlug || !mergedMarkdown || !mergedTitle) {
      return {
        kind: 'invalid',
        op: 'merge',
        message: `skip merge (missing fields): ${JSON.stringify(raw)}`,
      };
    }
    return { kind: 'merge', into, fromSlug, mergedTitle, mergedMarkdown };
  }
  if (raw.op === 'reorder') {
    const order = Array.isArray(raw.order) ? raw.order.map(String) : [];
    return { kind: 'reorder', order };
  }
  return { kind: 'invalid', op: String(raw.op), message: `skip unknown op: ${String(raw.op)}` };
}

function parseOrganizeDecision(raw: unknown): OrganizeDecision {
  if (!isRecord(raw)) {
    return {
      operations: [{ kind: 'invalid', op: 'unknown', message: 'skip unknown op: undefined' }],
      reasoning: '',
    };
  }
  const operations = Array.isArray(raw.operations) ? raw.operations.map(parseOrganizeOp) : [];
  return { operations, reasoning: stringField(raw, 'reasoning') };
}

export async function applyPlaceDecision(
  store: PlanStore,
  newPlan: Plan,
  rawDecision: unknown,
): Promise<string> {
  const decision = parsePlaceDecision(rawDecision);

  if (decision.kind === 'invalid') {
    return fallbackPlaceAtBack(
      store,
      newPlan,
      `${decision.message}; left '${newPlan.slug}' at end of queue`,
    );
  }

  if (decision.kind === 'merge') {
    let mergedFromPath: string | null = null;
    try {
      const { from } = await store.atomicMerge({
        targetSlug: decision.targetSlug,
        fromSlug: newPlan.slug,
        newTitle: decision.mergedTitle,
        newSteps: (target) => materializeSteps(decision.mergedMarkdown, target.steps),
        newCheckpoints: (target) => reconcileCheckpointsForMerge(target, decision.mergedMarkdown),
        bodyWriter: async (target) => {
          const targetPath = planFilePath(target);
          return replacePlanFileWithRollback(targetPath, decision.mergedMarkdown);
        },
      });
      mergedFromPath = planFilePath(from);
    } catch (err) {
      if (err instanceof PlanNotFound) {
        return fallbackPlaceAtBack(
          store,
          newPlan,
          `merge target '${decision.targetSlug}' not found; left '${newPlan.slug}' at end of queue`,
        );
      }
      if (err instanceof PlanNotReady) {
        return fallbackPlaceAtBack(
          store,
          newPlan,
          `merge target '${decision.targetSlug}' became ${err.status}; left '${newPlan.slug}' at end of queue`,
        );
      }
      if (err instanceof PlanSelfMerge) {
        return fallbackPlaceAtBack(
          store,
          newPlan,
          `merge target '${decision.targetSlug}' matched new plan; left '${newPlan.slug}' at end of queue`,
        );
      }
      throw err;
    }
    try {
      await fs.unlink(mergedFromPath);
    } catch (err) {
      if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
    return (
      `merged '${newPlan.slug}' into '${decision.targetSlug}'` +
      `${decision.reasoning ? `: ${decision.reasoning}` : ''}`
    );
  }

  const plans = await store.read();
  const readyOthers = plans.filter((p) => p.status === 'ready' && p.slug !== newPlan.slug);
  let where: string;
  try {
    if (decision.position >= readyOthers.length) {
      await store.move(newPlan.slug, { toBack: true });
      where = 'end of queue';
    } else {
      const beforeSlug = readyOthers[decision.position]!.slug;
      await store.move(newPlan.slug, { before: beforeSlug });
      where = `position ${decision.position} (before '${beforeSlug}')`;
    }
  } catch (err) {
    if (!(err instanceof PlanNotFound) && !(err instanceof ImplementingLocked)) {
      throw err;
    }
    where = 'end of queue (move failed)';
  }
  return `placed '${newPlan.slug}' at ${where}${decision.reasoning ? `: ${decision.reasoning}` : ''}`;
}

export function summarizeOrganizeDecision(rawDecision: unknown): string[] {
  const decision = parseOrganizeDecision(rawDecision);
  const ops = decision.operations ?? [];
  if (ops.length === 0) return ['(no operations — queue is fine as-is)'];
  const out: string[] = [];
  for (const op of ops) {
    if (op.kind === 'merge') {
      out.push(
        `merge: '${op.fromSlug}' → '${op.into}' ` +
          `(new title: ${JSON.stringify(op.mergedTitle)})`,
      );
    } else if (op.kind === 'reorder') {
      out.push(`reorder: ${op.order.join(' → ')}`);
    } else {
      out.push(op.message.replace(/^skip /, ''));
    }
  }
  return out;
}

export async function applyOrganizeDecision(
  store: PlanStore,
  rawDecision: unknown,
): Promise<string[]> {
  const decision = parseOrganizeDecision(rawDecision);
  const summary: string[] = [];
  const ops = decision.operations;
  const orderedOps = [
    ...ops.filter((op) => op.kind === 'merge'),
    ...ops.filter((op) => op.kind === 'reorder'),
    ...ops.filter((op) => op.kind !== 'merge' && op.kind !== 'reorder'),
  ];
  for (const op of orderedOps) {
    if (op.kind === 'merge') {
      let mergedFromPath: string | null = null;
      try {
        const { from } = await store.atomicMerge({
          targetSlug: op.into,
          fromSlug: op.fromSlug,
          newTitle: op.mergedTitle,
          newSteps: (target) => materializeSteps(op.mergedMarkdown, target.steps),
          newCheckpoints: (target) => reconcileCheckpointsForMerge(target, op.mergedMarkdown),
          bodyWriter: async (target) => {
            const targetPath = planFilePath(target);
            return replacePlanFileWithRollback(targetPath, op.mergedMarkdown);
          },
        });
        mergedFromPath = planFilePath(from);
        summary.push(`  merged '${op.fromSlug}' → '${op.into}'`);
      } catch (err) {
        if (err instanceof PlanNotFound) {
          summary.push(`  skip merge ${op.fromSlug} → ${op.into}: slug not found`);
          continue;
        }
        if (err instanceof PlanNotReady) {
          summary.push(`  skip merge ${op.fromSlug} → ${op.into}: ${err.slug} is ${err.status}`);
          continue;
        }
        if (err instanceof PlanSelfMerge) {
          summary.push(`  skip merge ${op.fromSlug} → ${op.into}: cannot merge a plan into itself`);
          continue;
        }
        throw err;
      }
      try {
        await fs.unlink(mergedFromPath);
      } catch (err) {
        if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }
    } else if (op.kind === 'reorder') {
      try {
        await store.reorderReady(op.order);
        summary.push(`  reordered ${op.order.length} ready plan(s)`);
      } catch (err) {
        if (err instanceof ImplementingLocked) {
          summary.push(`  skip reorder: ${err.message}`);
        } else if (err instanceof Error) {
          summary.push(`  skip reorder: ${err.message}`);
        } else {
          throw err;
        }
      }
    } else {
      summary.push(`  ${op.message}`);
    }
  }
  return summary;
}
