import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { CLAUDE_COMMAND_BODY, CLAUDE_SKILL_BODY } from './claude-assets.js';
import { cmdInitClaude, cmdPlanPrompt } from './init-claude.js';
import { PLAN_SYSTEM_PROMPT } from './lauren-prompts.js';

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
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lauren-init-claude-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('cmdInitClaude', () => {
  test('writes both files into ./.claude/ by default', async () => {
    const out = new StringStream();
    const err = new StringStream();
    const rc = await cmdInitClaude({
      force: false,
      global: false,
      cwd: tmpRoot,
      out: out as unknown as NodeJS.WritableStream,
      err: err as unknown as NodeJS.WritableStream,
    });
    expect(rc).toBe(0);
    const cmdPath = path.join(tmpRoot, '.claude/commands/lauren.md');
    const skillPath = path.join(tmpRoot, '.claude/skills/lauren/SKILL.md');
    expect(await fs.readFile(cmdPath, 'utf8')).toBe(CLAUDE_COMMAND_BODY);
    expect(await fs.readFile(skillPath, 'utf8')).toBe(CLAUDE_SKILL_BODY);
    expect(out.text).toContain(cmdPath);
    expect(out.text).toContain(skillPath);
  });

  test('writes local files into the git repo root when run from a subdirectory', async () => {
    execFileSync('git', ['init'], { cwd: tmpRoot, stdio: 'ignore' });
    const nested = path.join(tmpRoot, 'packages/app');
    await fs.mkdir(nested, { recursive: true });

    const out = new StringStream();
    const err = new StringStream();
    const rc = await cmdInitClaude({
      force: false,
      global: false,
      cwd: nested,
      out: out as unknown as NodeJS.WritableStream,
      err: err as unknown as NodeJS.WritableStream,
    });

    const cmdPath = path.join(tmpRoot, '.claude/commands/lauren.md');
    const nestedCmdPath = path.join(nested, '.claude/commands/lauren.md');
    expect(rc).toBe(0);
    expect(await fs.readFile(cmdPath, 'utf8')).toBe(CLAUDE_COMMAND_BODY);
    await expect(fs.access(nestedCmdPath)).rejects.toThrow();
    expect(out.text).toContain(cmdPath);
    expect(out.text).not.toContain(nestedCmdPath);
  });

  test('--global writes into ~/.claude/', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lauren-init-home-'));
    try {
      const out = new StringStream();
      const err = new StringStream();
      const rc = await cmdInitClaude({
        force: false,
        global: true,
        home,
        out: out as unknown as NodeJS.WritableStream,
        err: err as unknown as NodeJS.WritableStream,
      });
      expect(rc).toBe(0);
      expect(await fs.readFile(path.join(home, '.claude/commands/lauren.md'), 'utf8')).toBe(
        CLAUDE_COMMAND_BODY,
      );
      expect(await fs.readFile(path.join(home, '.claude/skills/lauren/SKILL.md'), 'utf8')).toBe(
        CLAUDE_SKILL_BODY,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test('refuses to overwrite an existing file without --force', async () => {
    const cmdPath = path.join(tmpRoot, '.claude/commands/lauren.md');
    await fs.mkdir(path.dirname(cmdPath), { recursive: true });
    await fs.writeFile(cmdPath, 'preexisting', 'utf8');
    const out = new StringStream();
    const err = new StringStream();
    const rc = await cmdInitClaude({
      force: false,
      global: false,
      cwd: tmpRoot,
      out: out as unknown as NodeJS.WritableStream,
      err: err as unknown as NodeJS.WritableStream,
    });
    expect(rc).toBe(1);
    expect(err.text).toMatch(/already exists?/);
    expect(err.text).toContain('--force');
    expect(err.text).toContain(cmdPath);
    expect(await fs.readFile(cmdPath, 'utf8')).toBe('preexisting');
  });

  test('--force overwrites existing files', async () => {
    const cmdPath = path.join(tmpRoot, '.claude/commands/lauren.md');
    await fs.mkdir(path.dirname(cmdPath), { recursive: true });
    await fs.writeFile(cmdPath, 'old', 'utf8');
    const out = new StringStream();
    const err = new StringStream();
    const rc = await cmdInitClaude({
      force: true,
      global: false,
      cwd: tmpRoot,
      out: out as unknown as NodeJS.WritableStream,
      err: err as unknown as NodeJS.WritableStream,
    });
    expect(rc).toBe(0);
    expect(await fs.readFile(cmdPath, 'utf8')).toBe(CLAUDE_COMMAND_BODY);
  });
});

describe('cmdPlanPrompt', () => {
  test('writes PLAN_SYSTEM_PROMPT to the provided stream', () => {
    const out = new StringStream();
    const rc = cmdPlanPrompt(out as unknown as NodeJS.WritableStream);
    expect(rc).toBe(0);
    expect(out.text).toContain('Session task: write an implementation plan');
    expect(out.text).toContain('All paths in this prompt are relative to the repository root');
    expect(out.text.startsWith(PLAN_SYSTEM_PROMPT)).toBe(true);
  });
});

describe('Claude skill body', () => {
  test('anchors plan writes and registration at the repo root', () => {
    expect(CLAUDE_SKILL_BODY).toContain('repo_root="$(git rev-parse --show-toplevel');
    expect(CLAUDE_SKILL_BODY).toContain('Do not write a plan under a');
    expect(CLAUDE_SKILL_BODY).toContain('nested subdirectory');
  });
});

describe('committed .claude/ files match TS constants', () => {
  // The test runner runs from the repo root.
  const repoRoot = process.cwd();

  test('.claude/commands/lauren.md matches CLAUDE_COMMAND_BODY', async () => {
    const content = await fs.readFile(path.join(repoRoot, '.claude/commands/lauren.md'), 'utf8');
    expect(content).toBe(CLAUDE_COMMAND_BODY);
  });

  test('.claude/skills/lauren/SKILL.md matches CLAUDE_SKILL_BODY', async () => {
    const content = await fs.readFile(
      path.join(repoRoot, '.claude/skills/lauren/SKILL.md'),
      'utf8',
    );
    expect(content).toBe(CLAUDE_SKILL_BODY);
  });
});
