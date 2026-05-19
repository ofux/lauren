import { describe, expect, test } from 'vitest';

import type { Step } from './core/steps.js';
import type { Plan } from './core/types.js';
import {
  fixPlanPrompt,
  fixPrompt,
  implementPlanPrompt,
  implementPrompt,
} from './executor-prompts.js';

const STEP: Step = { id: '1.2', title: 'Wire button' };
const PLAN = { slug: 'demo', title: 'Demo plan', path: '.lauren/plans/demo.md' } as unknown as Plan;
const NOTES = '/abs/.lauren/notes/demo.notes.html';

describe('implementPrompt', () => {
  test('omits the notes instruction when notesPath is null', () => {
    const prompt = implementPrompt(STEP, PLAN.path, [], null);
    expect(prompt).not.toContain('implementation-notes');
    expect(prompt).not.toContain('.notes.html');
  });

  test('appends notes instruction with the absolute path and a step-tagged section', () => {
    const prompt = implementPrompt(STEP, PLAN.path, [], NOTES);
    expect(prompt).toContain('implementation-notes HTML file');
    expect(prompt).toContain(NOTES);
    expect(prompt).toContain('data-step="1.2"');
    expect(prompt).toContain('data-phase="implement"');
    expect(prompt).toContain('APPEND a new');
  });
});

describe('implementPlanPrompt', () => {
  test('omits the notes instruction when notesPath is null', () => {
    const prompt = implementPlanPrompt(PLAN, 'plan body', [], null);
    expect(prompt).not.toContain('implementation-notes');
  });

  test('inserts notes instruction before the embedded plan body', () => {
    const prompt = implementPlanPrompt(PLAN, 'PLAN-BODY-MARKER', [], NOTES);
    expect(prompt).toContain('implementation-notes HTML file');
    expect(prompt).toContain(NOTES);
    expect(prompt).toContain('data-phase="implement"');
    expect(prompt).not.toContain('data-step=');
    // Notes instruction sits before the plan body so the agent sees the
    // bookkeeping requirement before diving into the spec.
    expect(prompt.indexOf(NOTES)).toBeLessThan(prompt.indexOf('PLAN-BODY-MARKER'));
  });
});

describe('fixPrompt', () => {
  test('omits the notes instruction when notesPath is null', () => {
    const prompt = fixPrompt(STEP, 'review feedback', null);
    expect(prompt).not.toContain('implementation-notes');
  });

  test('appends a fix-phase section to the notes file', () => {
    const prompt = fixPrompt(STEP, 'review feedback', NOTES);
    expect(prompt).toContain(NOTES);
    expect(prompt).toContain('continue the implementation-notes file');
    expect(prompt).toContain('data-step="1.2"');
    expect(prompt).toContain('data-phase="fix"');
  });
});

describe('fixPlanPrompt', () => {
  test('omits the notes instruction when notesPath is null', () => {
    const prompt = fixPlanPrompt(PLAN, 'review feedback', null);
    expect(prompt).not.toContain('implementation-notes');
  });

  test('appends a fix-phase section to the notes file', () => {
    const prompt = fixPlanPrompt(PLAN, 'review feedback', NOTES);
    expect(prompt).toContain(NOTES);
    expect(prompt).toContain('continue the implementation-notes file');
    expect(prompt).toContain('data-phase="fix"');
    expect(prompt).not.toContain('data-step=');
  });
});
