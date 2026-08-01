import { listProfileTemplates, type ProfileTemplateName } from '../../core/profile-template';

export type LifecyclePromptKind =
  | 'create'
  | 'copy'
  | 'rename'
  | 'remove'
  | 'validate'
  | 'backup'
  | 'default';

export type LifecyclePhase =
  | 'idle'
  | 'prompting'
  | 'executing'
  | 'success'
  | 'error';

export type LifecycleState = {
  phase: LifecyclePhase;
  kind: LifecyclePromptKind | null;
  profileName: string;
  input: string;
  step: number;
  selectedTemplate: ProfileTemplateName | null;
  message: string;
  findings: LifecycleFinding[] | null;
};

export type LifecycleFinding = {
  severity: 'error' | 'warning';
  code: string;
  message: string;
};

export type LifecycleAction =
  | { type: 'START_PROMPT'; kind: LifecyclePromptKind; profileName: string }
  | { type: 'START_IMMEDIATE'; kind: LifecyclePromptKind; profileName: string }
  | { type: 'INPUT_CHAR'; char: string }
  | { type: 'BACKSPACE' }
  | { type: 'SELECT_TEMPLATE'; templateName: ProfileTemplateName }
  | { type: 'NEXT_STEP' }
  | { type: 'SUBMIT' }
  | { type: 'CANCEL' }
  | { type: 'EXECUTE_SUCCESS'; message: string }
  | { type: 'EXECUTE_ERROR'; message: string }
  | { type: 'SET_FINDINGS'; findings: LifecycleFinding[] }
  | { type: 'DISMISS' };

export function initialLifecycleState(): LifecycleState {
  return {
    phase: 'idle',
    kind: null,
    profileName: '',
    input: '',
    step: 1,
    selectedTemplate: null,
    message: '',
    findings: null,
  };
}

export function lifecycleReducer(state: LifecycleState, action: LifecycleAction): LifecycleState {
  switch (action.type) {
    case 'START_PROMPT': {
      return {
        ...initialLifecycleState(),
        phase: 'prompting',
        kind: action.kind,
        profileName: action.profileName,
        step: action.kind === 'create' ? 1 : 0,
      };
    }

    case 'START_IMMEDIATE': {
      return {
        ...initialLifecycleState(),
        phase: 'executing',
        kind: action.kind,
        profileName: action.profileName,
      };
    }

    case 'INPUT_CHAR': {
      if (state.phase !== 'prompting') return state;
      return { ...state, input: state.input + action.char };
    }

    case 'BACKSPACE': {
      if (state.phase !== 'prompting') return state;
      return { ...state, input: state.input.slice(0, -1) };
    }

    case 'SELECT_TEMPLATE': {
      if (state.phase !== 'prompting' || state.kind !== 'create') return state;
      return { ...state, selectedTemplate: action.templateName };
    }

    case 'NEXT_STEP': {
      if (state.phase !== 'prompting') return state;
      return { ...state, step: state.step + 1, input: '' };
    }

    case 'SUBMIT': {
      if (state.phase !== 'prompting') return state;
      return { ...state, phase: 'executing' };
    }

    case 'CANCEL': {
      if (state.phase === 'prompting' && state.kind === 'create' && state.step > 1) {
        return { ...state, step: state.step - 1, input: '' };
      }
      return initialLifecycleState();
    }

    case 'EXECUTE_SUCCESS': {
      if (state.phase !== 'executing') return state;
      return { ...state, phase: 'success', message: action.message };
    }

    case 'EXECUTE_ERROR': {
      if (state.phase !== 'executing') return state;
      return { ...state, phase: 'error', message: action.message };
    }

    case 'SET_FINDINGS': {
      return { ...state, findings: action.findings };
    }

    case 'DISMISS': {
      if (state.phase === 'success' || state.phase === 'error') {
        return initialLifecycleState();
      }
      return state;
    }

    default:
      return state;
  }
}

export const LIFECYCLE_ACTIONS = [
  { key: 'n', kind: 'create' as const, labelKey: 'lifecycle.create' as const },
  { key: 'c', kind: 'copy' as const, labelKey: 'lifecycle.copy' as const },
  { key: 'r', kind: 'rename' as const, labelKey: 'lifecycle.rename' as const },
  { key: 'd', kind: 'default' as const, labelKey: 'lifecycle.default' as const },
  { key: 'v', kind: 'validate' as const, labelKey: 'lifecycle.validate' as const },
  { key: 'b', kind: 'backup' as const, labelKey: 'lifecycle.backup' as const },
  { key: 'x', kind: 'remove' as const, labelKey: 'lifecycle.remove' as const },
] as const;

export const TEMPLATE_LIST = listProfileTemplates();
