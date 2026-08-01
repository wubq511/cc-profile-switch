import type {
  CollisionResolution,
  InstallMode,
  InstallPreview,
  LocalSkillSourceInfo,
} from '../../../core/skills-install';
import { suggestCollisionName } from '../../../core/skills-install';

// Local Skill installation wizard state machine (spec §7.2).
//
// One decision per screen, `esc` walks back. Phases that need async work
// ('validating', 'confirming', 'installing') are entered synchronously by this
// reducer; the React component watches phase transitions and runs the
// matching core-service call, dispatching the result action back. This keeps
// the reducer pure and unit-testable without touching the filesystem.

export type InstallWizardPhase =
  | 'source' // typing the Local Skill Source path
  | 'validating' // async: validateLocalSkillSource
  | 'mode' // choosing Copy (default) or Link
  | 'confirming' // async: previewInstall
  | 'confirm' // target-change preview + health checks
  | 'collision' // resolve name collision (rename / replace / back)
  | 'installing' // async: installLocalSkill
  | 'success'
  | 'error';

export type InstallWizardState = {
  open: boolean;
  phase: InstallWizardPhase;
  profileName: string;
  sourceInput: string;
  sourceInfo: LocalSkillSourceInfo | null;
  sourceError: string;
  mode: InstallMode; // 'copy' is the default per spec
  name: string;
  preview: InstallPreview | null;
  collisionInput: string;
  collisionError: string;
  collisionResolution: CollisionResolution | null;
  message: string; // success/error message
};

export type InstallWizardAction =
  | { type: 'START'; profileName: string }
  | { type: 'SOURCE_CHAR'; char: string }
  | { type: 'SOURCE_BACKSPACE' }
  | { type: 'SOURCE_SUBMIT' } // → validating
  | { type: 'SOURCE_RESOLVED'; info: LocalSkillSourceInfo } // → mode
  | { type: 'SOURCE_INVALID'; message: string } // → source + error
  | { type: 'SELECT_MODE'; mode: InstallMode }
  | { type: 'MODE_CONFIRM' } // → confirming
  | { type: 'PREVIEW_READY'; preview: InstallPreview } // → confirm or collision
  | { type: 'PREVIEW_FAILED'; message: string } // → mode + error
  | { type: 'CONFIRM_INSTALL' } // → installing (no collision) or collision
  | { type: 'COLLISION_CHAR'; char: string }
  | { type: 'COLLISION_BACKSPACE' }
  | { type: 'COLLISION_RENAME' } // accept collisionInput → confirming
  | { type: 'COLLISION_REPLACE' } // → installing with replace
  | { type: 'FALLBACK_TO_COPY' } // link-incapable: re-preview as copy
  | { type: 'INSTALL_SUCCESS'; message: string }
  | { type: 'INSTALL_ERROR'; message: string }
  | { type: 'DISMISS' } // success/error → closed
  | { type: 'CANCEL' }; // esc: walk back one decision

export function initialInstallWizardState(): InstallWizardState {
  return {
    open: false,
    phase: 'source',
    profileName: '',
    sourceInput: '',
    sourceInfo: null,
    sourceError: '',
    mode: 'copy',
    name: '',
    preview: null,
    collisionInput: '',
    collisionError: '',
    collisionResolution: null,
    message: '',
  };
}

export function installWizardReducer(
  state: InstallWizardState,
  action: InstallWizardAction,
): InstallWizardState {
  switch (action.type) {
    case 'START': {
      return {
        ...initialInstallWizardState(),
        open: true,
        phase: 'source',
        profileName: action.profileName,
        mode: 'copy', // Copy pre-selected (spec §7.2)
      };
    }

    case 'SOURCE_CHAR': {
      if (state.phase !== 'source') return state;
      return { ...state, sourceInput: state.sourceInput + action.char, sourceError: '' };
    }

    case 'SOURCE_BACKSPACE': {
      if (state.phase !== 'source') return state;
      return { ...state, sourceInput: state.sourceInput.slice(0, -1), sourceError: '' };
    }

    case 'SOURCE_SUBMIT': {
      if (state.phase !== 'source') return state;
      if (state.sourceInput.trim().length === 0) return state;
      return { ...state, phase: 'validating', sourceError: '' };
    }

    case 'SOURCE_RESOLVED': {
      if (state.phase !== 'validating') return state;
      return {
        ...state,
        phase: 'mode',
        sourceInfo: action.info,
        name: action.info.suggestedName,
        sourceError: '',
      };
    }

    case 'SOURCE_INVALID': {
      if (state.phase !== 'validating') return state;
      return { ...state, phase: 'source', sourceError: action.message };
    }

    case 'SELECT_MODE': {
      if (state.phase !== 'mode') return state;
      return { ...state, mode: action.mode };
    }

    case 'MODE_CONFIRM': {
      if (state.phase !== 'mode') return state;
      return { ...state, phase: 'confirming' };
    }

    case 'PREVIEW_READY': {
      if (state.phase !== 'confirming') return state;
      return { ...state, phase: 'confirm', preview: action.preview, collisionError: '' };
    }

    case 'PREVIEW_FAILED': {
      if (state.phase !== 'confirming') return state;
      return { ...state, phase: 'mode', sourceError: action.message };
    }

    case 'CONFIRM_INSTALL': {
      if (state.phase !== 'confirm') return state;
      const preview = state.preview;
      if (!preview) return state;
      // Health blocker: refuse to install when pre-install checks fail. The
      // confirm step surfaces the blocker and offers the Copy fallback for a
      // link-incapable platform (spec §7.2 — "and only then the install action").
      if (!preview.canInstall) return state;
      if (preview.collides) {
        // Prefill the rename input with the suggested suffix.
        const suggestion = suggestCollisionName(preview.name, new Set(preview.existingNames));
        return {
          ...state,
          phase: 'collision',
          collisionInput: suggestion,
          collisionError: '',
          collisionResolution: null,
        };
      }
      return { ...state, phase: 'installing', collisionResolution: null };
    }

    case 'COLLISION_CHAR': {
      if (state.phase !== 'collision') return state;
      return {
        ...state,
        collisionInput: state.collisionInput + action.char,
        collisionError: '',
      };
    }

    case 'COLLISION_BACKSPACE': {
      if (state.phase !== 'collision') return state;
      return {
        ...state,
        collisionInput: state.collisionInput.slice(0, -1),
        collisionError: '',
      };
    }

    case 'COLLISION_RENAME': {
      if (state.phase !== 'collision') return state;
      const trimmed = state.collisionInput.trim();
      if (trimmed.length === 0) {
        return { ...state, collisionError: 'Name cannot be empty.' };
      }
      // Apply the chosen name and re-preview to confirm it no longer collides.
      return {
        ...state,
        name: trimmed,
        phase: 'confirming',
        collisionResolution: 'rename',
        collisionError: '',
      };
    }

    case 'COLLISION_REPLACE': {
      if (state.phase !== 'collision') return state;
      return {
        ...state,
        phase: 'installing',
        collisionResolution: 'replace',
        collisionError: '',
      };
    }

    case 'FALLBACK_TO_COPY': {
      // Link-incapable platform: switch to Copy with the same source and re-preview.
      if (state.phase !== 'confirm') return state;
      return { ...state, mode: 'copy', phase: 'confirming' };
    }

    case 'INSTALL_SUCCESS': {
      if (state.phase !== 'installing') return state;
      return { ...state, phase: 'success', message: action.message };
    }

    case 'INSTALL_ERROR': {
      if (state.phase !== 'installing') return state;
      return { ...state, phase: 'error', message: action.message };
    }

    case 'DISMISS': {
      if (state.phase === 'success' || state.phase === 'error') {
        return { ...initialInstallWizardState() };
      }
      return state;
    }

    case 'CANCEL': {
      // esc walks back one decision per screen (spec §7.2).
      switch (state.phase) {
        case 'source':
          return { ...initialInstallWizardState() };
        case 'validating':
          return { ...state, phase: 'source' };
        case 'mode':
          return { ...state, phase: 'source' };
        case 'confirming':
          return { ...state, phase: 'mode' };
        case 'confirm':
          return { ...state, phase: 'mode' };
        case 'collision':
          return { ...state, phase: 'confirm', collisionResolution: null, collisionError: '' };
        case 'success':
        case 'error':
          return { ...initialInstallWizardState() };
        case 'installing':
          // Cannot cancel mid-install (atomic transaction).
          return state;
        default:
          return state;
      }
    }

    default:
      return state;
  }
}
