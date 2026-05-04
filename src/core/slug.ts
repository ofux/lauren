export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

export function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    process.stderr.write(
      `error: invalid slug '${slug}'. Must match ${SLUG_RE.source} ` +
        `(lowercase kebab-case, 2–49 chars).\n`,
    );
    process.exit(1);
  }
}
