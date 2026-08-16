import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { EditSessionManager, type EditSession } from '../../../core/edit-session';
import { updateProfileDescription } from '../../../core/profile-management';
import { getProfileTemplatePaths } from '../../../core/profile-template';
import { openWithSystemEditor } from '../../../platform/editor';
import type { I18nParams, LocaleKey } from '../i18n/react';
import type { WorkbenchData, WorkbenchProfile } from '../profile-data';

type UseEditSessionsOptions = {
  workbenchData: WorkbenchData;
  selectedIndex: number;
  appHomePath: string;
  flash: (message: string) => void;
  refreshData: () => Promise<void>;
  t: (key: LocaleKey, params?: I18nParams) => string;
  /** `workbench.editor` from config.json (§13.2): editor command override for
   *  the external-edit handoff, e.g. "code -w". Undefined = VS Code default. */
  editorOverride?: string;
  setCapture: Dispatch<SetStateAction<boolean>>;
};

/** External-edit sessions (§8 watching) + the Profile description inline edit
 *  (S5), extracted from app.tsx (issue #89). Owns the one EditSessionManager
 *  instance for the Workbench lifetime, shared by every consumer (top-level
 *  edit, resource views, Auto Memory drill). */
export function useEditSessions({
  workbenchData,
  selectedIndex,
  appHomePath,
  flash,
  refreshData,
  t,
  editorOverride,
  setCapture,
}: UseEditSessionsOptions): {
  sessionManager: EditSessionManager;
  topLevelEditSession: EditSession | undefined;
  editingDescription: boolean;
  descriptionDraft: string;
  startDescriptionEdit: () => void;
  /** Input handling for the inline description edit; true = key consumed. */
  handleDescriptionInput: (input: string, key: Record<string, boolean>) => boolean;
  handleTopLevelEdit: () => Promise<void>;
  handleFallbackSystemEditor: (filePath: string) => Promise<void>;
  handleFallbackRetry: (filePath: string) => void;
  handleFallbackDismiss: (filePath: string) => void;
} {
  const [, forceRerender] = useState(0);
  // Edit-session manager — one instance for the Workbench lifetime, shared by
  // every consumer (top-level edit, resource views, Auto Memory drill). Its
  // onChange bumps a counter so watching banners re-render on external saves.
  const sessionManagerRef = useRef(
    new EditSessionManager({
      editorOverride,
      onChange: () => forceRerender((n: number) => n + 1),
    }),
  );
  const editSessionManager = sessionManagerRef.current;

  // Release file watchers and debounce timers when the Workbench unmounts
  // (e.g. on launch remount or exit) so the manager never leaks OS handles.
  useEffect(() => {
    return () => {
      editSessionManager.dispose();
    };
  }, [editSessionManager]);

  const currentProfile = (): WorkbenchProfile | undefined => workbenchData.profiles[selectedIndex];

  // Profile description inline edit (S5): the draft state lives here; the
  // input row renders on the Profile card in place of the description line.
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState('');

  const startDescriptionEdit = useCallback(() => {
    const profile = currentProfile();
    if (!profile) return;
    setDescriptionDraft(profile.description);
    setEditingDescription(true);
    // Own every key while the inline edit is active — the sidebar's lifecycle
    // letters (n/c/r/d/…) must not fire on top of the typed draft.
    setCapture(true);
  }, [selectedIndex, workbenchData, setCapture]);

  const cancelDescriptionEdit = useCallback(() => {
    setEditingDescription(false);
    setDescriptionDraft('');
    setCapture(false);
  }, [setCapture]);

  const submitDescriptionEdit = useCallback(async () => {
    const profile = currentProfile();
    setEditingDescription(false);
    setCapture(false);
    if (!profile) return;
    const description = descriptionDraft.trim();
    setDescriptionDraft('');
    if (description === profile.description) return;

    try {
      await updateProfileDescription({ appHomePath, name: profile.name, description });
      flash(t('main.description.saved'));
      // Reload so the saved description is reflected on the card (S5).
      await refreshData();
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    }
  }, [descriptionDraft, selectedIndex, workbenchData, appHomePath, flash, refreshData, t, setCapture]);

  // Plain function (fresh closure per render): the root dispatcher re-sees the
  // latest state every render, matching the original inline block exactly.
  const handleDescriptionInput = (input: string, key: Record<string, boolean>): boolean => {
    if (!editingDescription) return false;
    if (key.escape) {
      cancelDescriptionEdit();
      return true;
    }
    if (key.return) {
      void submitDescriptionEdit();
      return true;
    }
    if (key.backspace || key.delete) {
      setDescriptionDraft((d) => d.slice(0, -1));
      return true;
    }
    if (!key.ctrl && !key.meta && input.length === 1) {
      setDescriptionDraft((d) => d + input);
    }
    return true;
  };

  // Top-level `e` (main-pane grid, a Profile selected): open the selected
  // Profile's User Memory (CLAUDE.md) in VS Code — the same file the
  // resource-level User Memory edit opens (§4.3 `e`, §8 watching). Reuses the
  // edit-session infrastructure rather than a parallel editor path.
  const handleTopLevelEdit = useCallback(async () => {
    const profile = currentProfile();
    if (!profile) return;
    if (!profile.resourceDetails.userMemory.exists) {
      flash(t('main.edit.missing'));
      return;
    }
    const filePath = getProfileTemplatePaths(appHomePath, profile.name).claudeMdPath;
    try {
      await sessionManagerRef.current.open(filePath);
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    }
  }, [selectedIndex, workbenchData, appHomePath, flash, t]);

  // §8 fallback actions when the editor handoff fails (VS Code unavailable) —
  // surfaced through FallbackMenu wherever the failed session is visible.
  const handleFallbackSystemEditor = useCallback(
    async (filePath: string) => {
      try {
        await openWithSystemEditor(filePath);
        // Handed off — end the session so the menu dismisses. No watcher: the
        // system editor is outside the VS Code watching/refresh contract.
        sessionManagerRef.current.endSession(filePath);
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error));
      }
    },
    [flash],
  );

  const handleFallbackRetry = useCallback((filePath: string) => {
    void sessionManagerRef.current.open(filePath);
  }, []);

  const handleFallbackDismiss = useCallback((filePath: string) => {
    sessionManagerRef.current.endSession(filePath);
  }, []);

  // Active edit session for the selected Profile's CLAUDE.md, so the top-level
  // grid can render the §8 watching banner with its change counter.
  const selectedProfile = currentProfile();
  const topLevelClaudeMdPath = selectedProfile
    ? getProfileTemplatePaths(appHomePath, selectedProfile.name).claudeMdPath
    : null;
  const topLevelEditSession = topLevelClaudeMdPath
    ? sessionManagerRef.current.getSession(topLevelClaudeMdPath)
    : undefined;

  return {
    sessionManager: editSessionManager,
    topLevelEditSession,
    editingDescription,
    descriptionDraft,
    startDescriptionEdit,
    handleDescriptionInput,
    handleTopLevelEdit,
    handleFallbackSystemEditor,
    handleFallbackRetry,
    handleFallbackDismiss,
  };
}
