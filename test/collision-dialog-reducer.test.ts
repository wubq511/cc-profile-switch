import { describe, expect, it } from 'vitest';

import {
  collisionDialogReducer,
  initialCollisionDialogState,
  suggestNewName,
} from '../src/tui/workbench/resources/collision-dialog-reducer';

describe('collisionDialogReducer', () => {
  it('starts in the choose phase with the suggested name prefilled', () => {
    const state = initialCollisionDialogState('topics-2.md');
    expect(state.phase).toBe('choose');
    expect(state.nameInput).toBe('topics-2.md');
    expect(state.error).toBeNull();
  });

  it('selecting restore-as-new-name opens the rename prompt', () => {
    const state = collisionDialogReducer(initialCollisionDialogState('topics-2.md'), {
      type: 'SELECT_RESTORE_AS_NEW_NAME',
    });
    expect(state.phase).toBe('rename');
    expect(state.nameInput).toBe('topics-2.md');
  });

  it('selecting delete-and-restore opens the one-confirm step', () => {
    const state = collisionDialogReducer(initialCollisionDialogState('topics-2.md'), {
      type: 'SELECT_DELETE_AND_RESTORE',
    });
    expect(state.phase).toBe('confirm-delete');
  });

  it('edits the rename input in the rename phase', () => {
    const afterSelect = collisionDialogReducer(initialCollisionDialogState('topics-2.md'), {
      type: 'SELECT_RESTORE_AS_NEW_NAME',
    });
    const typed = collisionDialogReducer(afterSelect, { type: 'NAME_CHAR', char: 'x' });
    expect(typed.nameInput).toBe('topics-2.mdx');
    const backspaced = collisionDialogReducer(typed, { type: 'NAME_BACKSPACE' });
    expect(backspaced.nameInput).toBe('topics-2.md');
  });

  it('records a name error and back returns to choose', () => {
    let state = collisionDialogReducer(initialCollisionDialogState('topics-2.md'), {
      type: 'SELECT_RESTORE_AS_NEW_NAME',
    });
    state = collisionDialogReducer(state, { type: 'NAME_ERROR', message: 'Enter a name first.' });
    expect(state.error).toBe('Enter a name first.');

    state = collisionDialogReducer(state, { type: 'BACK' });
    expect(state.phase).toBe('choose');
    expect(state.error).toBeNull();
  });

  it('ignores editing actions outside the rename phase', () => {
    let state = initialCollisionDialogState('topics-2.md');
    state = collisionDialogReducer(state, { type: 'NAME_CHAR', char: 'z' });
    expect(state.nameInput).toBe('topics-2.md');
  });

  it('ignores BACK in the choose phase (caller owns cancel)', () => {
    const state = collisionDialogReducer(initialCollisionDialogState('topics-2.md'), { type: 'BACK' });
    expect(state.phase).toBe('choose');
  });
});

describe('suggestNewName', () => {
  it('keeps the extension when inserting the numeric suffix', () => {
    expect(suggestNewName('topics.md', new Set())).toBe('topics-2.md');
  });

  it('appends the suffix directly for extension-less names', () => {
    expect(suggestNewName('pdf', new Set())).toBe('pdf-2');
  });

  it('skips names that already exist', () => {
    expect(suggestNewName('topics.md', new Set(['topics.md', 'topics-2.md']))).toBe('topics-3.md');
  });

  it('suggestions are distinct per extension variant', () => {
    // `topics` (no extension) and `topics.md` are different entries.
    expect(suggestNewName('topics', new Set(['topics.md']))).toBe('topics-2');
  });
});
