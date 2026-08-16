// Shared collision-resolution flow (spec §9.3).
//
// Modeled on the install-wizard reducer: pure state transitions that the
// resource rows drive from a keyboard handler, so the choose → rename /
// delete-confirm interactions are unit-testable without Ink.

export type CollisionDialogPhase = 'choose' | 'rename' | 'confirm-delete';

export type CollisionDialogState = {
  phase: CollisionDialogPhase;
  /** Prefilled with a suggested new name when the rename prompt opens. */
  nameInput: string;
  error: string | null;
};

export type CollisionDialogAction =
  | { type: 'SELECT_RESTORE_AS_NEW_NAME' }
  | { type: 'SELECT_DELETE_AND_RESTORE' }
  | { type: 'NAME_CHAR'; char: string }
  | { type: 'NAME_BACKSPACE' }
  | { type: 'NAME_CLEAR' }
  | { type: 'NAME_ERROR'; message: string }
  | { type: 'BACK' };

export function initialCollisionDialogState(suggestedName: string): CollisionDialogState {
  return { phase: 'choose', nameInput: suggestedName, error: null };
}

export function collisionDialogReducer(
  state: CollisionDialogState,
  action: CollisionDialogAction,
): CollisionDialogState {
  switch (action.type) {
    case 'SELECT_RESTORE_AS_NEW_NAME':
      if (state.phase !== 'choose') return state;
      return { ...state, phase: 'rename', error: null };

    case 'SELECT_DELETE_AND_RESTORE':
      if (state.phase !== 'choose') return state;
      return { ...state, phase: 'confirm-delete', error: null };

    case 'NAME_CHAR':
      if (state.phase !== 'rename') return state;
      return { ...state, nameInput: state.nameInput + action.char };

    case 'NAME_BACKSPACE':
      if (state.phase !== 'rename') return state;
      return { ...state, nameInput: state.nameInput.slice(0, -1) };

    case 'NAME_CLEAR':
      if (state.phase !== 'rename') return state;
      return { ...state, nameInput: '' };

    case 'NAME_ERROR':
      if (state.phase !== 'rename') return state;
      return { ...state, error: action.message };

    case 'BACK':
      if (state.phase === 'choose') return state;
      return { ...state, phase: 'choose', error: null };

    default:
      return state;
  }
}

/**
 * Suggest a non-colliding name for the restore-as-new-name prompt.
 *
 * Keeps the original extension so `topics.md` becomes `topics-2.md`; extension-
 * less names (skills, MCP keys) get the numeric suffix appended directly.
 */
export function suggestNewName(name: string, existingNames: ReadonlySet<string>): string {
  const dot = name.lastIndexOf('.');
  const hasExtension = dot > 0 && dot < name.length - 1;
  const base = hasExtension ? name.slice(0, dot) : name;
  const ext = hasExtension ? name.slice(dot) : '';
  let n = 2;
  while (existingNames.has(`${base}-${n}${ext}`)) n++;
  return `${base}-${n}${ext}`;
}
