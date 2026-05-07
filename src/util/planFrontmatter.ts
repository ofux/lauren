export interface PlanFrontmatter {
  name: string;
  description: string;
}

export interface ParsedPlan {
  frontmatter: PlanFrontmatter | null;
  body: string;
}

/**
 * Parse the YAML-style frontmatter block from a plan .md file.
 *
 * Recognized shape:
 *
 *     ---
 *     name: <slug>
 *     description: |
 *       3-4 lines describing the plan.
 *       What it does and what files it touches.
 *     ---
 *
 *     # Plan title …
 *
 * Both `name` and `description` are required. `description` may be inline on
 * one line or a `|` block scalar with consistently indented lines. If either
 * field is missing or the block is malformed, `frontmatter` is `null` and
 * `body` is the original input unchanged.
 */
export function parsePlanFrontmatter(raw: string): ParsedPlan {
  const normalized = raw.replace(/\r\n/g, '\n');

  if (!normalized.startsWith('---\n')) {
    return { frontmatter: null, body: raw };
  }

  const rest = normalized.slice(4);
  const closeRe = /^---[ \t]*(?:\n|$)/m;
  const closeMatch = closeRe.exec(rest);
  if (!closeMatch || closeMatch.index === undefined) {
    return { frontmatter: null, body: raw };
  }

  const blockText = rest.slice(0, closeMatch.index);
  const afterClose = rest.slice(closeMatch.index + closeMatch[0].length);
  const body = afterClose.startsWith('\n') ? afterClose.slice(1) : afterClose;

  const fields = new Map<string, string>();
  const lines = blockText.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/);
    if (!match) {
      i++;
      continue;
    }
    const key = match[1]!;
    const valuePart = match[2]!;
    if (valuePart === '|') {
      const collected: string[] = [];
      let indent: number | null = null;
      i++;
      while (i < lines.length) {
        const ln = lines[i]!;
        if (ln === '') {
          collected.push('');
          i++;
          continue;
        }
        const leading = ln.length - ln.trimStart().length;
        if (leading === 0) break;
        if (indent === null) indent = leading;
        if (leading < indent) break;
        collected.push(ln.slice(indent));
        i++;
      }
      while (collected.length > 0 && collected[collected.length - 1] === '') {
        collected.pop();
      }
      fields.set(key, collected.join('\n'));
    } else {
      fields.set(key, valuePart.trim());
      i++;
    }
  }

  const name = (fields.get('name') ?? '').trim();
  const description = (fields.get('description') ?? '').trim();
  if (!name || !description) {
    return { frontmatter: null, body: raw };
  }
  return { frontmatter: { name, description }, body };
}

/**
 * Render a frontmatter block as text that round-trips through
 * {@link parsePlanFrontmatter}. The block always ends with a closing `---`
 * followed by a single newline; callers typically prepend it to a blank line
 * + the plan body.
 */
export function formatPlanFrontmatter(fm: PlanFrontmatter): string {
  const descLines = fm.description.split('\n');
  const indented = descLines.map((l) => (l === '' ? '' : `  ${l}`)).join('\n');
  return `---\nname: ${fm.name}\ndescription: |\n${indented}\n---\n`;
}
