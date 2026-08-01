/**
 * Interaction harness tests — §15.5
 *
 * The interaction harness injects key sequences and asserts state transitions
 * and rendered content. Behavior is locked while visual snapshots remain
 * unpinned (§15.5: "Behavior contracts — keybindings, state transitions,
 * error paths, loading/degraded states — are locked as automated interaction
 * tests").
 *
 * Tests exercise the lifecycle reducer and controller state machine — pure
 * logic, no Ink rendering.
 */

import { describe, expect, it } from 'vitest';

import {
  initialLifecycleState,
  lifecycleReducer,
} from '../src/tui/workbench/lifecycle';

// ─── Key sequence → state transition tests ───────────────────────────────

describe('Interaction harness — key sequences drive state transitions', () => {
  it('idle → START_PROMPT → prompting (rename)', () => {
    const state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    expect(state.phase).toBe('prompting');
    expect(state.kind).toBe('rename');
    expect(state.profileName).toBe('coding');
  });

  it('prompting → INPUT_CHAR × N → input accumulated', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'd' });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'e' });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'v' });
    expect(state.input).toBe('dev');
  });

  it('prompting → BACKSPACE → last char deleted', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'x' });
    state = lifecycleReducer(state, { type: 'BACKSPACE' });
    expect(state.input).toBe('');
  });

  it('prompting → SUBMIT → executing', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'd' });
    state = lifecycleReducer(state, { type: 'SUBMIT' });
    expect(state.phase).toBe('executing');
    expect(state.input).toBe('d');
  });

  it('executing → EXECUTE_SUCCESS → success with flash', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'SUBMIT' });
    state = lifecycleReducer(state, { type: 'EXECUTE_SUCCESS', message: 'Renamed!' });
    expect(state.phase).toBe('success');
    expect(state.message).toBe('Renamed!');
    expect(state.messageId).toBe(1);
  });

  it('executing → EXECUTE_ERROR → error with code and guidance', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'SUBMIT' });
    state = lifecycleReducer(state, {
      type: 'EXECUTE_ERROR',
      message: 'Name taken.',
      code: 'PROFILE_NAME_EXISTS',
      guidance: 'Choose a different name.',
    });
    expect(state.phase).toBe('error');
    expect(state.errorCode).toBe('PROFILE_NAME_EXISTS');
    expect(state.guidance).toBe('Choose a different name.');
  });

  it('success → DISMISS → idle', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'SUBMIT' });
    state = lifecycleReducer(state, { type: 'EXECUTE_SUCCESS', message: 'OK' });
    state = lifecycleReducer(state, { type: 'DISMISS' });
    expect(state.phase).toBe('idle');
  });

  it('error → DISMISS → idle', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'SUBMIT' });
    state = lifecycleReducer(state, {
      type: 'EXECUTE_ERROR',
      message: 'Fail',
      code: 'X',
      guidance: 'Fix it',
    });
    state = lifecycleReducer(state, { type: 'DISMISS' });
    expect(state.phase).toBe('idle');
  });
});

// ─── Esc key → CANCEL transitions ───────────────────────────────────────

describe('Interaction harness — Esc cancels and walks back', () => {
  it('prompting → CANCEL → idle', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'CANCEL' });
    expect(state.phase).toBe('idle');
  });

  it('create step 2 → CANCEL → step 1', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'create',
      profileName: '',
    });
    state = lifecycleReducer(state, { type: 'SELECT_TEMPLATE', templateName: 'coding' });
    state = lifecycleReducer(state, { type: 'NEXT_STEP' });
    expect(state.step).toBe(2);
    state = lifecycleReducer(state, { type: 'CANCEL' });
    expect(state.step).toBe(1);
    expect(state.phase).toBe('prompting');
  });

  it('create step 1 → CANCEL → idle', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'create',
      profileName: '',
    });
    state = lifecycleReducer(state, { type: 'CANCEL' });
    expect(state.phase).toBe('idle');
  });

  it('confirm → CANCEL → idle (destructive panel dismissed)', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_CONFIRM',
      kind: 'remove',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'CANCEL' });
    expect(state.phase).toBe('idle');
  });
});

// ─── Destructive confirmation flow ──────────────────────────────────────

describe('Interaction harness — destructive confirmation flow', () => {
  it('idle → START_CONFIRM → confirm → executing → success', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_CONFIRM',
      kind: 'remove',
      profileName: 'coding',
    });
    expect(state.phase).toBe('confirm');
    expect(state.kind).toBe('remove');

    state = lifecycleReducer(state, { type: 'CONFIRM_CHOICE' });
    expect(state.phase).toBe('executing');

    state = lifecycleReducer(state, { type: 'EXECUTE_SUCCESS', message: 'Removed.' });
    expect(state.phase).toBe('success');
  });

  it('CONFIRM_CHOICE outside confirm phase is a no-op', () => {
    const state = lifecycleReducer(initialLifecycleState(), { type: 'CONFIRM_CHOICE' });
    expect(state.phase).toBe('idle');
  });
});

// ─── Immediate actions (validate, backup, default) ──────────────────────

describe('Interaction harness — immediate actions skip prompting', () => {
  it('idle → START_IMMEDIATE → executing directly', () => {
    const state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_IMMEDIATE',
      kind: 'validate',
      profileName: 'coding',
    });
    expect(state.phase).toBe('executing');
    expect(state.kind).toBe('validate');
  });

  it('immediate validate → EXECUTE_SUCCESS → success', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_IMMEDIATE',
      kind: 'validate',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'EXECUTE_SUCCESS', message: 'Valid.' });
    expect(state.phase).toBe('success');
  });
});

// ─── Create-from-template two-step flow ─────────────────────────────────

describe('Interaction harness — create-from-template two-step flow', () => {
  it('step 1: template picker → SELECT_TEMPLATE → step 2: name input', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'create',
      profileName: '',
    });
    expect(state.step).toBe(1);

    state = lifecycleReducer(state, { type: 'SELECT_TEMPLATE', templateName: 'study' });
    expect(state.selectedTemplate).toBe('study');

    state = lifecycleReducer(state, { type: 'NEXT_STEP' });
    expect(state.step).toBe(2);

    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'm' });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'y' });
    expect(state.input).toBe('my');

    state = lifecycleReducer(state, { type: 'SUBMIT' });
    expect(state.phase).toBe('executing');
    expect(state.selectedTemplate).toBe('study');
    expect(state.input).toBe('my');
  });
});

// ─── Save-template flow ─────────────────────────────────────────────────

describe('Interaction harness — save-template flow', () => {
  it('prompt → submit → SHOW_TEMPLATE_SUMMARY → confirm → save', () => {
    const summary = { strippedCount: 3, autoMemoryExcluded: true };
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'save-template',
      profileName: 'coding',
    });
    expect(state.phase).toBe('prompting');
    expect(state.step).toBe(0);

    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'b' });
    state = lifecycleReducer(state, { type: 'SUBMIT' });
    expect(state.phase).toBe('executing');

    state = lifecycleReducer(state, { type: 'SHOW_TEMPLATE_SUMMARY', summary });
    expect(state.phase).toBe('confirm');
    expect(state.templateSummary).toEqual(summary);

    state = lifecycleReducer(state, { type: 'CONFIRM_CHOICE' });
    expect(state.phase).toBe('executing');

    state = lifecycleReducer(state, { type: 'EXECUTE_SUCCESS', message: 'Saved!' });
    expect(state.phase).toBe('success');
  });

  it('CANCEL from save-template confirm resets the summary', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'save-template',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'SUBMIT' });
    state = lifecycleReducer(state, {
      type: 'SHOW_TEMPLATE_SUMMARY',
      summary: { strippedCount: 2, autoMemoryExcluded: true },
    });
    expect(state.phase).toBe('confirm');
    state = lifecycleReducer(state, { type: 'CANCEL' });
    expect(state.phase).toBe('idle');
    expect(state.templateSummary).toBeNull();
  });
});

// ─── Flash generation counter ───────────────────────────────────────────

describe('Interaction harness — flash generation counter', () => {
  it('success flash carries messageId = 1', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_IMMEDIATE',
      kind: 'backup',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'EXECUTE_SUCCESS', message: 'Done!' });
    expect(state.messageId).toBe(1);
  });

  it('duplicate success is a no-op (stays at generation 1)', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_IMMEDIATE',
      kind: 'backup',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'EXECUTE_SUCCESS', message: 'Done!' });
    const duplicate = lifecycleReducer(state, { type: 'EXECUTE_SUCCESS', message: 'Done!' });
    expect(duplicate.messageId).toBe(1);
  });

  it('error flash also bumps the counter', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_IMMEDIATE',
      kind: 'validate',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, {
      type: 'EXECUTE_ERROR',
      message: 'Fail',
      code: 'X',
      guidance: 'Fix it',
    });
    expect(state.messageId).toBe(1);
    expect(state.phase).toBe('error');
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────

describe('Interaction harness — edge cases', () => {
  it('BACKSPACE on empty input is a no-op', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'BACKSPACE' });
    expect(state.input).toBe('');
  });

  it('SHOW_TEMPLATE_SUMMARY is gated to save-template flow', () => {
    const summary = { strippedCount: 1, autoMemoryExcluded: true };

    // idle: no-op
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'SHOW_TEMPLATE_SUMMARY',
      summary,
    });
    expect(state.phase).toBe('idle');

    // rename prompting: no-op
    state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'SHOW_TEMPLATE_SUMMARY', summary });
    expect(state.phase).toBe('prompting');
    expect(state.templateSummary).toBeNull();
  });

  it('initial state is idle with null fields', () => {
    const state = initialLifecycleState();
    expect(state.phase).toBe('idle');
    expect(state.kind).toBeNull();
    expect(state.input).toBe('');
    expect(state.message).toBe('');
    expect(state.messageId).toBe(0);
    expect(state.templateSummary).toBeNull();
  });
});
