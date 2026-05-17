import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { CODEX_SKILL_BODY } from './codex-assets.js';
import { cmdInitCodex } from './init-codex.js';

class StringStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  get text(): string {
    return this.chunks.join('');
  }
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lauren-init-codex-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('cmdInitCodex', () => {
  test('writes the skill file into ./.agents/ by default', async () => {
    const out = new StringStream();
    const err = new StringStream();
    const rc = await cmdInitCodex({
      force: false,
      global: false,
      cwd: tmpRoot,
      out: out as unknown as NodeJS.WritableStream,
      err: err as unknown as NodeJS.WritableStream,
    });
    expect(rc).toBe(0);
    const skillPath = path.join(tmpRoot, '.agents/skills/lauren/SKILL.md');
    expect(await fs.readFile(skillPath, 'utf8')).toBe(CODEX_SKILL_BODY);
    expect(out.text).toContain(skillPath);
  });

  test('writes into the git repo root when run from a subdirectory', async () => {
    execFileSync('git', ['init'], { cwd: tmpRoot, stdio: 'ignore' });
    const nested = path.join(tmpRoot, 'packages/app');
    await fs.mkdir(nested, { recursive: true });

    const out = new StringStream();
    const err = new StringStream();
    const rc = await cmdInitCodex({
      force: false,
      global: false,
      cwd: nested,
      out: out as unknown as NodeJS.WritableStream,
      err: err as unknown as NodeJS.WritableStream,
    });

    const skillPath = path.join(tmpRoot, '.agents/skills/lauren/SKILL.md');
    const nestedSkillPath = path.join(nested, '.agents/skills/lauren/SKILL.md');
    expect(rc).toBe(0);
    expect(await fs.readFile(skillPath, 'utf8')).toBe(CODEX_SKILL_BODY);
    await expect(fs.access(nestedSkillPath)).rejects.toThrow();
    expect(out.text).toContain(skillPath);
    expect(out.text).not.toContain(nestedSkillPath);
  });

  test('--global writes into ~/.agents/', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lauren-init-codex-home-'));
    try {
      const out = new StringStream();
      const err = new StringStream();
      const rc = await cmdInitCodex({
        force: false,
        global: true,
        home,
        out: out as unknown as NodeJS.WritableStream,
        err: err as unknown as NodeJS.WritableStream,
      });
      expect(rc).toBe(0);
      expect(await fs.readFile(path.join(home, '.agents/skills/lauren/SKILL.md'), 'utf8')).toBe(
        CODEX_SKILL_BODY,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test('refuses to overwrite an existing file without --force', async () => {
    const skillPath = path.join(tmpRoot, '.agents/skills/lauren/SKILL.md');
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, 'preexisting', 'utf8');
    const out = new StringStream();
    const err = new StringStream();
    const rc = await cmdInitCodex({
      force: false,
      global: false,
      cwd: tmpRoot,
      out: out as unknown as NodeJS.WritableStream,
      err: err as unknown as NodeJS.WritableStream,
    });
    expect(rc).toBe(1);
    expect(err.text).toMatch(/already exists?/);
    expect(err.text).toContain('--force');
    expect(err.text).toContain(skillPath);
    expect(await fs.readFile(skillPath, 'utf8')).toBe('preexisting');
  });

  test('--force overwrites existing files', async () => {
    const skillPath = path.join(tmpRoot, '.agents/skills/lauren/SKILL.md');
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, 'old', 'utf8');
    const out = new StringStream();
    const err = new StringStream();
    const rc = await cmdInitCodex({
      force: true,
      global: false,
      cwd: tmpRoot,
      out: out as unknown as NodeJS.WritableStream,
      err: err as unknown as NodeJS.WritableStream,
    });
    expect(rc).toBe(0);
    expect(await fs.readFile(skillPath, 'utf8')).toBe(CODEX_SKILL_BODY);
  });
});

describe('Codex skill body', () => {
  test('inlines the full plan system prompt', () => {
    expect(CODEX_SKILL_BODY).toContain('# Session task: write an implementation plan');
    expect(CODEX_SKILL_BODY).toContain(
      'All paths in this prompt are relative to the repository root',
    );
  });

  test('does not shell out to load the prompt', () => {
    expect(CODEX_SKILL_BODY).not.toContain('lauren _plan-prompt');
  });
});

describe('committed .agents/ files match TS constants', () => {
  const repoRoot = process.cwd();

  test('.agents/skills/lauren/SKILL.md matches CODEX_SKILL_BODY', async () => {
    const content = await fs.readFile(
      path.join(repoRoot, '.agents/skills/lauren/SKILL.md'),
      'utf8',
    );
    expect(content).toBe(CODEX_SKILL_BODY);
  });
});
