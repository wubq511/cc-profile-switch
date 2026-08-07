import { listProfileTemplates, type ProfileTemplateName } from '../../core/profile-template';
import type { LaunchPlan } from '../../core/launcher';
import type { ValidationFinding } from '../../core/validator';

export type LifecyclePromptKind =
  | 'create'
  | 'copy'
  | 'rename'
  | 'remove'
  | 'validate'
  | 'backup'
  | 'default'
  | 'save-template';

export type LaunchPhase =
  | 'idle'
  | 'bar'          // pre-launch bar (l key)
  | 'dir-screen'   // directory screen (L key)
  | 'dry-run'      // dry-run page (d key)
  | 'launching'    // Claude Code is running
  | 'exited';      // Claude Code exited, showing flash

export type LifecyclePhase =
  | 'idle'
  | 'prompting'
  | 'confirm'   // destructive-action inline panel (§9.1)
  | 'executing'
  | 'success'
  | 'error';

export type RecentDir = {
  path: string;
  lastUsedAt: string;
};

export type LifecycleState = {
  phase: LifecyclePhase;
  kind: LifecyclePromptKind | null;
  profileName: string;
  input: string;
  step: number;
  /** Built-in template name or custom template name selected in the create flow. */
  selectedTemplate: string | null;
  /** Stripping summary shown on the save-template confirm panel (§11.3). */
  templateSummary: { strippedCount: number; autoMemoryExcluded: boolean } | null;
  message: string;
  /** Monotonic counter carried by success/error flashes (generation guard). */
  messageId: number;
  /** Error context for the boxed error panel. */
  errorCode?: string;
  guidance?: string;
  findings: LifecycleFinding[] | null;
  // Launch flow state
  launch: LaunchState;
};

export type LaunchState = {
  phase: LaunchPhase;
  dir: string;                    // chosen launch directory
  dirInput: string;               // typed path in directory screen
  recentDirs: RecentDir[];        // MRU recent directories
  recentIndex: number;            // selected recent index (tab cycling)
  dryRunPlan: LaunchPlan | null;  // cached dry-run plan
  validationFindings: ValidationFinding[];  // inline findings
  exitCode: number | null;        // Claude exit code after resume
};

export type LifecycleFinding = {
  severity: 'error' | 'warning';
  code: string;
  message: string;
};

export type LifecycleAction =
  | { type: 'START_PROMPT'; kind: LifecyclePromptKind; profileName: string }
  | { type: 'START_IMMEDIATE'; kind: LifecyclePromptKind; profileName: string }
  | { type: 'START_CONFIRM'; kind: LifecyclePromptKind; profileName: string }
  | { type: 'CONFIRM_CHOICE' }
  | { type: 'INPUT_CHAR'; char: string }
  | { type: 'BACKSPACE' }
  | { type: 'SELECT_TEMPLATE'; templateName: string }
  | { type: 'NEXT_STEP' }
  | { type: 'SUBMIT' }
  | {
      type: 'SHOW_TEMPLATE_SUMMARY';
      summary: { strippedCount: number; autoMemoryExcluded: boolean };
    }
  | { type: 'CANCEL' }
  | { type: 'EXECUTE_SUCCESS'; message: string }
  | { type: 'EXECUTE_ERROR'; message: string; code?: string; guidance?: string }
  | { type: 'SET_FINDINGS'; findings: LifecycleFinding[] }
  | { type: 'DISMISS' }
  // Launch flow actions
  | { type: 'LAUNCH_BAR'; profileName: string; cwd: string; recentDirs: RecentDir[] }
  | { type: 'LAUNCH_DIR_SCREEN' }
  | { type: 'LAUNCH_SET_DIR'; dir: string }
  | { type: 'LAUNCH_DIR_INPUT_CHAR'; char: string }
  | { type: 'LAUNCH_DIR_BACKSPACE' }
  | { type: 'LAUNCH_DIR_TAB' }
  | { type: 'LAUNCH_DIR_PICK'; index: number }
  | { type: 'LAUNCH_CONFIRM' }
  | { type: 'LAUNCH_SHOW_DRYRUN'; plan: LaunchPlan }
  | { type: 'LAUNCH_SET_VALIDATION'; findings: ValidationFinding[] }
  | { type: 'LAUNCH_START' }
  | { type: 'LAUNCH_EXIT'; exitCode: number | null }
  | { type: 'LAUNCH_DISMISS' };

export function initialLifecycleState(): LifecycleState {
  return {
    phase: 'idle',
    kind: null,
    profileName: '',
    input: '',
    step: 1,
    selectedTemplate: null,
    templateSummary: null,
    message: '',
    messageId: 0,
    errorCode: undefined,
    guidance: undefined,
    findings: null,
    launch: initialLaunchState(),
  };
}

export function initialLaunchState(): LaunchState {
  return {
    phase: 'idle',
    dir: process.cwd(),
    dirInput: '',
    recentDirs: [],
    recentIndex: -1,
    dryRunPlan: null,
    validationFindings: [],
    exitCode: null,
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

    case 'START_CONFIRM': {
      return {
        ...initialLifecycleState(),
        phase: 'confirm',
        kind: action.kind,
        profileName: action.profileName,
      };
    }

    case 'CONFIRM_CHOICE': {
      if (state.phase !== 'confirm') return state;
      return { ...state, phase: 'executing' };
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

    case 'SHOW_TEMPLATE_SUMMARY': {
      // Save-template flow: SUBMIT ran the stripping preview (prompting →
      // executing), then this moves to the light-confirm panel with the
      // summary. The template name stays in `input`; nothing is saved yet.
      if (state.kind !== 'save-template') return state;
      if (state.phase !== 'prompting' && state.phase !== 'executing') return state;
      return { ...state, phase: 'confirm', templateSummary: action.summary };
    }

    case 'CANCEL': {
      if (state.phase === 'prompting' && state.kind === 'create' && state.step > 1) {
        return { ...state, step: state.step - 1, input: '' };
      }
      return initialLifecycleState();
    }

    case 'EXECUTE_SUCCESS': {
      if (state.phase !== 'executing') return state;
      return { ...state, phase: 'success', message: action.message, messageId: state.messageId + 1 };
    }

    case 'EXECUTE_ERROR': {
      if (state.phase !== 'executing') return state;
      return {
        ...state,
        phase: 'error',
        message: action.message,
        messageId: state.messageId + 1,
        errorCode: action.code,
        guidance: action.guidance,
      };
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

    // Launch flow
    case 'LAUNCH_BAR': {
      return {
        ...initialLifecycleState(),
        launch: {
          ...initialLaunchState(),
          phase: 'bar',
          dir: action.cwd,
          recentDirs: action.recentDirs,
        },
        profileName: action.profileName,
      };
    }

    case 'LAUNCH_DIR_SCREEN': {
      if (state.launch.phase !== 'bar') return state;
      return {
        ...state,
        launch: {
          ...state.launch,
          phase: 'dir-screen',
          dirInput: '',
          recentIndex: -1,
        },
      };
    }

    case 'LAUNCH_SET_DIR': {
      if (state.launch.phase !== 'dir-screen') return state;
      return {
        ...state,
        launch: {
          ...state.launch,
          dir: action.dir,
          phase: 'bar',
        },
      };
    }

    case 'LAUNCH_DIR_INPUT_CHAR': {
      if (state.launch.phase !== 'dir-screen') return state;
      return {
        ...state,
        launch: {
          ...state.launch,
          dirInput: state.launch.dirInput + action.char,
          recentIndex: -1,
        },
      };
    }

    case 'LAUNCH_DIR_BACKSPACE': {
      if (state.launch.phase !== 'dir-screen') return state;
      return {
        ...state,
        launch: {
          ...state.launch,
          dirInput: state.launch.dirInput.slice(0, -1),
        },
      };
    }

    case 'LAUNCH_DIR_TAB': {
      if (state.launch.phase !== 'dir-screen') return state;
      const { recentDirs, recentIndex } = state.launch;
      if (recentDirs.length === 0) return state;
      const nextIndex = (recentIndex + 1) % recentDirs.length;
      return {
        ...state,
        launch: {
          ...state.launch,
          recentIndex: nextIndex,
          dirInput: '',
        },
      };
    }

    case 'LAUNCH_DIR_PICK': {
      if (state.launch.phase !== 'dir-screen') return state;
      const picked = state.launch.recentDirs[action.index];
      if (!picked) return state;
      return {
        ...state,
        launch: {
          ...state.launch,
          dir: picked.path,
          phase: 'bar',
        },
      };
    }

    case 'LAUNCH_CONFIRM': {
      if (state.launch.phase !== 'bar') return state;
      const hasErrors = state.launch.validationFindings.some((f) => f.severity === 'error');
      if (hasErrors) return state;
      return {
        ...state,
        launch: {
          ...state.launch,
          phase: 'launching',
        },
      };
    }

    case 'LAUNCH_SHOW_DRYRUN': {
      if (state.launch.phase !== 'bar') return state;
      return {
        ...state,
        launch: {
          ...state.launch,
          phase: 'dry-run',
          dryRunPlan: action.plan,
        },
      };
    }

    case 'LAUNCH_SET_VALIDATION': {
      return {
        ...state,
        launch: {
          ...state.launch,
          validationFindings: action.findings,
        },
      };
    }

    case 'LAUNCH_START': {
      if (state.launch.phase !== 'dry-run') return state;
      return {
        ...state,
        launch: {
          ...state.launch,
          phase: 'launching',
        },
      };
    }

    case 'LAUNCH_EXIT': {
      if (state.launch.phase !== 'launching') return state;
      return {
        ...state,
        launch: {
          ...state.launch,
          phase: 'exited',
          exitCode: action.exitCode,
        },
      };
    }

    case 'LAUNCH_DISMISS': {
      if (state.launch.phase === 'exited') {
        return {
          ...state,
          launch: initialLaunchState(),
        };
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
  { key: 's', kind: 'save-template' as const, labelKey: 'lifecycle.saveTemplate' as const },
  { key: 'x', kind: 'remove' as const, labelKey: 'lifecycle.remove' as const },
] as const;

export const LAUNCH_ACTIONS = [
  { key: 'l', labelKey: 'lifecycle.launch' as const },
  { key: 'L', labelKey: 'lifecycle.launchDir' as const },
] as const;

let templateListCache: ProfileTemplateName[] | undefined;

/** Built-in template names, resolved on first use — importing this module must
 *  not call into core at load time. */
export function getTemplateList(): readonly ProfileTemplateName[] {
  templateListCache ??= listProfileTemplates();
  return templateListCache;
}
