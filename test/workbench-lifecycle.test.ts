import { describe, expect, it } from 'vitest';
import {
  initialLifecycleState,
  lifecycleReducer,
} from '../src/tui/workbench/lifecycle';

describe('lifecycle reducer', () => {
  it('starts in idle state', () => {
    const state = initialLifecycleState();
    expect(state.phase).toBe('idle');
  });

  it('transitions idle → prompting on START_PROMPT', () => {
    const state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    expect(state.phase).toBe('prompting');
    expect(state.kind).toBe('rename');
    expect(state.profileName).toBe('coding');
    expect(state.input).toBe('');
  });

  it('transitions prompting → idle on CANCEL', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'CANCEL' });
    expect(state.phase).toBe('idle');
  });

  it('accumulates input on INPUT_CHAR', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'n' });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'e' });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'w' });
    expect(state.input).toBe('new');
  });

  it('deletes last char on BACKSPACE', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'a' });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'b' });
    state = lifecycleReducer(state, { type: 'BACKSPACE' });
    expect(state.input).toBe('a');
  });

  it('transitions prompting → executing on SUBMIT', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'n' });
    state = lifecycleReducer(state, { type: 'SUBMIT' });
    expect(state.phase).toBe('executing');
    expect(state.input).toBe('n');
  });

  it('transitions executing → success on EXECUTE_SUCCESS', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'SUBMIT' });
    state = lifecycleReducer(state, { type: 'EXECUTE_SUCCESS', message: 'Renamed.' });
    expect(state.phase).toBe('success');
    expect(state.message).toBe('Renamed.');
  });

  it('transitions executing → error on EXECUTE_ERROR', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'SUBMIT' });
    state = lifecycleReducer(state, { type: 'EXECUTE_ERROR', message: 'Name taken.' });
    expect(state.phase).toBe('error');
    expect(state.message).toBe('Name taken.');
  });

  it('transitions success → idle on DISMISS', () => {
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

  it('transitions error → idle on DISMISS', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'SUBMIT' });
    state = lifecycleReducer(state, { type: 'EXECUTE_ERROR', message: 'Fail' });
    state = lifecycleReducer(state, { type: 'DISMISS' });
    expect(state.phase).toBe('idle');
  });

  it('handles create-from-template two-step flow', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'create',
      profileName: '',
    });
    expect(state.phase).toBe('prompting');
    expect(state.kind).toBe('create');
    expect(state.step).toBe(1); // step 1 = template picker

    // Select template (arrow down to 'study')
    state = lifecycleReducer(state, { type: 'SELECT_TEMPLATE', templateName: 'study' });
    expect(state.selectedTemplate).toBe('study');

    // Advance to step 2 = name input
    state = lifecycleReducer(state, { type: 'NEXT_STEP' });
    expect(state.step).toBe(2);

    // Type name
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'm' });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'y' });
    expect(state.input).toBe('my');

    // Submit
    state = lifecycleReducer(state, { type: 'SUBMIT' });
    expect(state.phase).toBe('executing');
    expect(state.input).toBe('my');
    expect(state.selectedTemplate).toBe('study');
  });

  it('handles immediate actions (validate, backup, default)', () => {
    const state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_IMMEDIATE',
      kind: 'validate',
      profileName: 'coding',
    });
    expect(state.phase).toBe('executing');
    expect(state.kind).toBe('validate');
    expect(state.profileName).toBe('coding');
  });

  it('BACKSPACE on empty input is a no-op', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'BACKSPACE' });
    expect(state.input).toBe('');
  });

  it('CANCEL from step 2 of create goes back to step 1', () => {
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

  it('CANCEL from step 1 of create goes to idle', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'create',
      profileName: '',
    });
    state = lifecycleReducer(state, { type: 'CANCEL' });
    expect(state.phase).toBe('idle');
  });
});
