import { getSkillsDirectoryPath } from '../../../core/skills-provenance';
import { resolveInside } from '../../../platform/path';
import type { RemoteInstallPreview } from '../../../core/skills-remote-install';
import type {
  CatalogedLocalSkillSource,
  CollisionResolution,
  InstallMode,
  InstallPreview,
  LocalSkillSourceInfo,
} from '../../../core/skills-install';
import { suggestCollisionName } from '../../../core/skills-install';

// Skill installation wizard state machine (spec §7.2 local, §7.3 remote).
//
// One decision per screen, `esc` walks back. Phases that need async work
// ('validating', 'confirming', 'installing', 'staging') are entered
// synchronously by this reducer; the React component watches phase transitions
// and runs the matching core-service call, dispatching the result action back.
// This keeps the reducer pure and unit-testable without touching the filesystem.

export type InstallWizardKind = 'local' | 'remote';

/** A remote source plus an optional `--skill` selection — travels together from
 * the Discover surface through the wizard's remote staging phase (§7.4/§7.3). */
export type InstallSourceRef = {
  source: string;
  skill?: string;
};

export type InstallWizardPhase =
  | 'kind' // pick Local (§7.2) or Remote (§7.3)
  | 'source-list' // pick a discovered Local Skill Source, or manual entry (§7.2 step 1)
  | 'source' // typing the Local Skill Source path (manual fallback)
  | 'validating' // async: validateLocalSkillSource
  | 'mode' // choosing Copy (default) or Link
  | 'confirming' // async: previewInstall (local)
  | 'source-remote' // typing the remote source (GitHub shorthand/URL, .git URL, tree URL, SKILL.md URL)
  | 'staging' // async: acquireAndPreviewRemoteInstall (pinned adapter → staging → identity)
  | 'confirm' // target-change preview + health checks / identity
  | 'collision' // resolve name collision (rename / replace / back)
  | 'installing' // async: installLocalSkill | installRemoteSkill
  | 'success'
  | 'error';

export type InstallWizardState = {
  open: boolean;
  phase: InstallWizardPhase;
  profileName: string;
  profileRootPath: string | null;
  kind: InstallWizardKind; // 'local' is the default per spec §7.2
  // Local flow
  /** Discovered local sources for the step-1 pick list (empty until loaded). */
  localSources: CatalogedLocalSkillSource[];
  /** Highlighted row on the source-list step (rows = sources + manual entry). */
  sourceListIndex: number;
  /** True once the component delivered the discovered sources (empty is a valid result). */
  sourcesLoaded: boolean;
  sourceInput: string;
  sourceInfo: LocalSkillSourceInfo | null;
  sourceError: string;
  mode: InstallMode; // 'copy' is the default per spec
  preview: InstallPreview | null;
  // Remote flow
  remoteSourceInput: string;
  remoteSourceError: string;
  /** Optional `--skill` selection for a multi-Skill remote source (a skills.sh
   * owner/repo shorthand; the Discover surface sets it). */
  remoteSkill: string | null;
  stagingRoot: string | null; // set after a successful staging phase; cleaned up on abandon
  stagedName: string | null;
  remotePreview: RemoteInstallPreview | null;
  // Shared
  name: string;
  collisionInput: string;
  collisionError: string;
  collisionResolution: CollisionResolution | null;
  message: string; // success/error message
};

export type InstallWizardAction =
  | { type: 'START'; profileName: string; profileRootPath?: string }
  | { type: 'START_REMOTE'; profileName: string; profileRootPath?: string } & InstallSourceRef
  | { type: 'KIND_SELECT_LOCAL' } // → source-list
  | { type: 'KIND_SELECT_REMOTE' } // → source-remote
  | { type: 'SOURCES_LOADED'; sources: CatalogedLocalSkillSource[] } // populate the step-1 list
  | { type: 'SOURCE_LIST_MOVE'; delta: 1 | -1 }
  | { type: 'SOURCE_LIST_PICK' } // → validating (a source row) or source (manual row)
  | { type: 'SOURCE_CHAR'; char: string }
  | { type: 'SOURCE_BACKSPACE' }
  | { type: 'SOURCE_SUBMIT' } // → validating
  | { type: 'SOURCE_RESOLVED'; info: LocalSkillSourceInfo } // → mode
  | { type: 'SOURCE_INVALID'; message: string } // → source + error
  | { type: 'SELECT_MODE'; mode: InstallMode }
  | { type: 'MODE_CONFIRM' } // → confirming
  | { type: 'PREVIEW_READY'; preview: InstallPreview } // → confirm or collision
  | { type: 'PREVIEW_FAILED'; message: string } // → mode + error
  | { type: 'REMOTE_SOURCE_CHAR'; char: string }
  | { type: 'REMOTE_SOURCE_BACKSPACE' }
  | { type: 'REMOTE_SOURCE_SUBMIT' } // → staging
  | { type: 'REMOTE_STAGED'; preview: RemoteInstallPreview } // → confirm or collision
  | { type: 'REMOTE_STAGING_FAILED'; message: string } // → source-remote + error
  | { type: 'CONFIRM_INSTALL' } // → installing (no collision) or collision
  | { type: 'COLLISION_CHAR'; char: string }
  | { type: 'COLLISION_BACKSPACE' }
  | { type: 'COLLISION_RENAME' } // accept collisionInput → confirm (remote) or confirming (local)
  | { type: 'COLLISION_REPLACE' } // → installing with replace
  | { type: 'FALLBACK_TO_COPY' } // link-incapable: re-preview as copy
  | { type: 'INSTALL_SUCCESS'; message: string }
  | { type: 'INSTALL_ERROR'; message: string }
  | { type: 'DISMISS' } // success/error → closed
  | { type: 'CANCEL' }; // esc: walk back one decision

export function initialInstallWizardState(): InstallWizardState {
  return {
    open: false,
    phase: 'kind',
    profileName: '',
    profileRootPath: null,
    kind: 'local',
    localSources: [],
    sourceListIndex: 0,
    sourcesLoaded: false,
    sourceInput: '',
    sourceInfo: null,
    sourceError: '',
    mode: 'copy',
    preview: null,
    remoteSourceInput: '',
    remoteSourceError: '',
    remoteSkill: null,
    stagingRoot: null,
    stagedName: null,
    remotePreview: null,
    name: '',
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
        phase: 'kind',
        profileName: action.profileName,
        profileRootPath: action.profileRootPath ?? null,
        mode: 'copy', // Copy pre-selected (spec §7.2)
      };
    }

    // Discover-surface entry (spec §7.4): stage a known remote source directly,
    // skipping the kind picker. `skill` carries a `--skill` selection for a
    // multi-Skill owner/repo shorthand (a skills.sh result).
    case 'START_REMOTE': {
      return {
        ...initialInstallWizardState(),
        open: true,
        phase: 'staging',
        profileName: action.profileName,
        profileRootPath: action.profileRootPath ?? null,
        kind: 'remote',
        remoteSourceInput: action.source,
        remoteSkill: action.skill ?? null,
        remoteSourceError: '',
      };
    }

    case 'KIND_SELECT_LOCAL': {
      if (state.phase !== 'kind') return state;
      // Spec §7.2 step 1: pick the Local Skill Source from a list (manual path
      // entry is the fallback row). The component loads localSources on entry.
      return { ...state, kind: 'local', phase: 'source-list' };
    }

    case 'KIND_SELECT_REMOTE': {
      if (state.phase !== 'kind') return state;
      return { ...state, kind: 'remote', phase: 'source-remote' };
    }

    case 'SOURCES_LOADED': {
      if (state.phase !== 'source-list') return state;
      const maxIndex = action.sources.length; // rows = sources + manual-entry row
      return {
        ...state,
        localSources: action.sources,
        sourcesLoaded: true,
        sourceListIndex: Math.min(state.sourceListIndex, maxIndex),
      };
    }

    case 'SOURCE_LIST_MOVE': {
      if (state.phase !== 'source-list') return state;
      const rowCount = state.localSources.length + 1; // + the manual-entry row
      const next = state.sourceListIndex + action.delta;
      const clamped = Math.max(0, Math.min(next, rowCount - 1));
      return { ...state, sourceListIndex: clamped };
    }

    case 'SOURCE_LIST_PICK': {
      if (state.phase !== 'source-list') return state;
      const picked = state.localSources[state.sourceListIndex];
      if (picked) {
        // Revalidate through the normal validating phase (the catalog entry
        // may have gone stale since listing).
        return {
          ...state,
          phase: 'validating',
          sourceInput: picked.sourcePath,
          sourceError: '',
        };
      }
      // The manual-entry row: fall back to the typed-path step (arbitrary
      // local paths must remain possible).
      return { ...state, phase: 'source', sourceError: '' };
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

    case 'REMOTE_SOURCE_CHAR': {
      if (state.phase !== 'source-remote') return state;
      return { ...state, remoteSourceInput: state.remoteSourceInput + action.char, remoteSourceError: '' };
    }

    case 'REMOTE_SOURCE_BACKSPACE': {
      if (state.phase !== 'source-remote') return state;
      return { ...state, remoteSourceInput: state.remoteSourceInput.slice(0, -1), remoteSourceError: '' };
    }

    case 'REMOTE_SOURCE_SUBMIT': {
      if (state.phase !== 'source-remote') return state;
      if (state.remoteSourceInput.trim().length === 0) return state;
      return { ...state, phase: 'staging', remoteSourceError: '' };
    }

    case 'REMOTE_STAGED': {
      if (state.phase !== 'staging') return state;
      const preview = action.preview;
      const name = preview.name;
      if (preview.collides) {
        const suggestion = suggestCollisionName(name, new Set(preview.existingNames));
        return {
          ...state,
          phase: 'collision',
          name,
          stagingRoot: preview.stagingRoot,
          stagedName: preview.stagedName,
          remotePreview: preview,
          collisionInput: suggestion,
          collisionError: '',
          collisionResolution: null,
        };
      }
      return {
        ...state,
        phase: 'confirm',
        name,
        stagingRoot: preview.stagingRoot,
        stagedName: preview.stagedName,
        remotePreview: preview,
        collisionResolution: null,
      };
    }

    case 'REMOTE_STAGING_FAILED': {
      if (state.phase !== 'staging') return state;
      return { ...state, phase: 'source-remote', remoteSourceError: action.message };
    }

    case 'CONFIRM_INSTALL': {
      if (state.phase !== 'confirm') return state;
      if (state.kind === 'remote') {
        const preview = state.remotePreview;
        if (!preview) return state;
        if (preview.collides) {
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
      if (state.kind === 'remote' && state.remotePreview && state.profileRootPath) {
        // The staged tree is unchanged; recompute the preview purely with the new
        // name (no re-acquire). Collision is re-checked against existingNames.
        const newTarget = resolveInside(getSkillsDirectoryPath(state.profileRootPath), trimmed);
        const collides = state.remotePreview.existingNames.includes(trimmed);
        const previewLines = rebuildRemotePreviewLines(state.remotePreview, newTarget);
        const remotePreview: RemoteInstallPreview = {
          ...state.remotePreview,
          name: trimmed,
          targetPath: newTarget,
          previewLines,
          collides,
        };
        return {
          ...state,
          name: trimmed,
          phase: collides ? 'collision' : 'confirm',
          collisionResolution: 'rename',
          collisionError: collides ? 'Name already in use.' : '',
          remotePreview,
        };
      }
      // Local: re-preview with the chosen name to confirm it no longer collides.
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
      return { ...state, phase: 'success', message: action.message, stagingRoot: null };
    }

    case 'INSTALL_ERROR': {
      if (state.phase !== 'installing') return state;
      // A failed install leaves the staging root orphaned; the component cleans
      // it up on close. Drop the reference here so the reducer stays pure.
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
        case 'kind':
          return { ...initialInstallWizardState() };
        case 'source-list':
          return { ...state, phase: 'kind' };
        case 'source':
          // Manual entry is the fallback row of the source list — esc returns
          // to the list, not the kind picker.
          return { ...state, phase: 'source-list' };
        case 'validating':
          return { ...state, phase: 'source-list' };
        case 'mode':
          return { ...state, phase: 'source-list' };
        case 'confirming':
          return state.kind === 'remote'
            ? { ...state, phase: 'source-remote' }
            : { ...state, phase: 'mode' };
        case 'source-remote':
          return { ...state, phase: 'kind' };
        case 'staging':
          return { ...state, phase: 'source-remote' };
        case 'confirm':
          return state.kind === 'remote'
            ? { ...state, phase: 'source-remote' }
            : { ...state, phase: 'mode' };
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

// Rebuild the remote preview's display lines with a new target path (used when
// the user renames on the collision step — the staged tree is unchanged).
function rebuildRemotePreviewLines(
  preview: RemoteInstallPreview,
  targetPath: string,
): string[] {
  return [
    `acquire  ${preview.provenanceSource.url ?? ''}  →  staging`,
    `stage    ${preview.stagedName}/  (frontmatter name: ${preview.identity.name})`,
    `create   ${targetPath}/   (snapshot — Profile-owned)`,
    `record   skills-provenance.json  ← copy · source ${preview.provenanceSource.kind} · sha256 fingerprint`,
  ];
}
