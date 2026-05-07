import { describe, expect, test } from 'vitest';
import { formatPlanFrontmatter, parsePlanFrontmatter } from './planFrontmatter.js';

describe('parsePlanFrontmatter', () => {
  test('parses a block-scalar description', () => {
    const raw = [
      '---',
      'name: add-auth',
      'description: |',
      '  Add password reset flow with token model,',
      '  email-based reset endpoint, and reset form UI.',
      '  Touches: src/auth/, src/email/.',
      '---',
      '',
      '# Add password reset',
      '',
      'Body goes here.',
      '',
    ].join('\n');
    const parsed = parsePlanFrontmatter(raw);
    expect(parsed.frontmatter).toEqual({
      name: 'add-auth',
      description:
        'Add password reset flow with token model,\n' +
        'email-based reset endpoint, and reset form UI.\n' +
        'Touches: src/auth/, src/email/.',
    });
    expect(parsed.body).toBe('# Add password reset\n\nBody goes here.\n');
  });

  test('parses an inline description', () => {
    const raw = '---\nname: foo\ndescription: short summary\n---\n\n# body\n';
    const parsed = parsePlanFrontmatter(raw);
    expect(parsed.frontmatter).toEqual({ name: 'foo', description: 'short summary' });
    expect(parsed.body).toBe('# body\n');
  });

  test('returns null when frontmatter is absent', () => {
    const raw = '# just a heading\n\nbody\n';
    const parsed = parsePlanFrontmatter(raw);
    expect(parsed.frontmatter).toBeNull();
    expect(parsed.body).toBe(raw);
  });

  test('returns null when name is missing', () => {
    const raw = '---\ndescription: only a description\n---\n\nbody\n';
    expect(parsePlanFrontmatter(raw).frontmatter).toBeNull();
  });

  test('returns null when description is missing', () => {
    const raw = '---\nname: foo\n---\n\nbody\n';
    expect(parsePlanFrontmatter(raw).frontmatter).toBeNull();
  });

  test('returns null when closing --- is absent', () => {
    const raw = '---\nname: foo\ndescription: x\n\nbody\n';
    expect(parsePlanFrontmatter(raw).frontmatter).toBeNull();
  });

  test('ignores unknown extra fields', () => {
    const raw = [
      '---',
      'name: foo',
      'description: x',
      'something_else: ignored',
      '---',
      '',
      'body',
      '',
    ].join('\n');
    const parsed = parsePlanFrontmatter(raw);
    expect(parsed.frontmatter).toEqual({ name: 'foo', description: 'x' });
  });

  test('handles CRLF line endings', () => {
    const raw = '---\r\nname: foo\r\ndescription: x\r\n---\r\n\r\n# body\r\n';
    const parsed = parsePlanFrontmatter(raw);
    expect(parsed.frontmatter).toEqual({ name: 'foo', description: 'x' });
  });

  test('does not treat indented --- inside block as terminator', () => {
    const raw = [
      '---',
      'name: foo',
      'description: |',
      '  line one',
      '  ---',
      '  line three',
      '---',
      '',
      'body',
    ].join('\n');
    const parsed = parsePlanFrontmatter(raw);
    expect(parsed.frontmatter?.description).toBe('line one\n---\nline three');
  });

  test('round-trips through formatPlanFrontmatter', () => {
    const fm = {
      name: 'my-plan',
      description: 'Line one.\nLine two.\nLine three.',
    };
    const formatted = formatPlanFrontmatter(fm);
    const parsed = parsePlanFrontmatter(`${formatted}\n# body\n`);
    expect(parsed.frontmatter).toEqual(fm);
  });
});
