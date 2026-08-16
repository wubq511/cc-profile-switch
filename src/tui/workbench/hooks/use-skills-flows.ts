import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import path from 'node:path';
import fs from 'fs-extra';

import { getAppHomePaths, loadAppConfig } from '../../../core/app-config';
import {
  installLocalSkill,
  listLocalSkillSources,
  previewInstall,
  validateLocalSkillSource,
} from '../../../core/skills-install';
import {
  acquireAndPreviewRemoteInstall,
  installRemoteSkill,
  type RemoteInstallPreview,
} from '../../../core/skills-remote-install';
import { SkillsDiscoverySession } from '../../../core/skills-discovery';
import { openUrlInBrowser } from '../../../platform/editor';
import { loadWorkbenchData, type WorkbenchData } from '../profile-data';
import type { InstallSourceRef } from '../skills/install-wizard-reducer';
import type { InstallWizardCallbacks } from '../skills/install-wizard';

/** Result caps for the Discover catalog (bounded interactive search). */
const DISCOVER_REPO_SKILL_LIMIT = 50;
const DISCOVER_SKILLSHUB_LIMIT = 20;

/** Default Discover session factory: real network + the `gh` token borrow,
 * bounded results. Overridable in tests. */
function defaultDiscoverySessionFactory(
  appHomePath: string,
  experimentalEnabled: boolean,
): SkillsDiscoverySession {
  return new SkillsDiscoverySession({
    appHomePath,
    experimentalEnabled,
    repoSkillLimit: DISCOVER_REPO_SKILL_LIMIT,
    skillshubLimit: DISCOVER_SKILLSHUB_LIMIT,
  });
}

type UseSkillsFlowsOptions = {
  workbenchData: WorkbenchData;
  selectedIndex: number;
  appHomePath: string;
  /** Catalog-backed translator handed to core services so their user-visible
   *  strings localize (see app.tsx). */
  coreTranslator: (key: string, params?: Record<string, string | number>) => string;
  setWorkbenchData: Dispatch<SetStateAction<WorkbenchData>>;
  /** Override the Discover session factory (tests inject a fake-session/http). */
  discoverySessionFactory?: (
    appHomePath: string,
    experimentalEnabled: boolean,
  ) => SkillsDiscoverySession;
  /** Override the app-config read (tests avoid touching the real app home). */
  configLoader?: (appHomePath: string) => Promise<ReturnType<typeof loadAppConfig>>;
};

/** Skill install wizard (issue #64, spec §7.2) + Discover surface (issue #68,
 *  spec §7.4) state and callbacks, extracted from app.tsx (issue #89). */
export function useSkillsFlows({
  workbenchData,
  selectedIndex,
  appHomePath,
  coreTranslator,
  setWorkbenchData,
  discoverySessionFactory,
  configLoader,
}: UseSkillsFlowsOptions): {
  wizardProfileName: string | null;
  wizardInitialRemote: InstallSourceRef | null;
  wizardOpen: boolean;
  discoverActive: boolean;
  discoverSession: SkillsDiscoverySession | null;
  wizardCallbacks: InstallWizardCallbacks;
  handleAddSkill: (profileName: string) => void;
  openDiscover: () => Promise<void>;
  handleDiscoverInstall: (source: string, skill?: string) => void;
  closeDiscover: () => void;
  handleOpenBrowser: (url: string) => void;
} {
  // Skill install wizard overlay (issue #64, spec §7.2)
  const [wizardProfileName, setWizardProfileName] = useState<string | null>(null);
  // Discover-surface install entry (issue #68, spec §7.4): when set, the wizard
  // opens pre-seeded in its remote staging phase for this source.
  const [wizardInitialRemote, setWizardInitialRemote] = useState<InstallSourceRef | null>(null);
  // Discover surface (issue #68, spec §7.4)
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discoverSession, setDiscoverSession] = useState<SkillsDiscoverySession | null>(null);
  // The Discover session survives closes so its session caches (incl. the
  // offline stale cache, spec §7.4) persist across re-opens within the app
  // session — and the `gh` token is borrowed once, not per open.
  const discoverSessionRef = useRef<SkillsDiscoverySession | null>(null);

  const wizardOpen = wizardProfileName !== null;
  const discoverActive = discoverOpen && discoverSession !== null;

  const handleAddSkill = useCallback((profileName: string) => {
    setWizardProfileName(profileName);
    setWizardInitialRemote(null);
  }, []);

  const openDiscover = useCallback(async () => {
    const profile = workbenchData.profiles[selectedIndex];
    if (!profile) return;
    if (!discoverSessionRef.current) {
      let experimentalEnabled = true;
      try {
        const config = await (configLoader ?? loadAppConfig)(appHomePath);
        experimentalEnabled = config.workbench?.skillsDiscoveryExperimental ?? true;
      } catch {
        // Unreadable config — default the experimental layer on (spec §7.4).
      }
      discoverSessionRef.current = (discoverySessionFactory ?? defaultDiscoverySessionFactory)(
        appHomePath,
        experimentalEnabled,
      );
    }
    setDiscoverSession(discoverSessionRef.current);
    setDiscoverOpen(true);
  }, [workbenchData, selectedIndex, appHomePath, discoverySessionFactory, configLoader]);

  // Install a discovered source through the §7.3 adapter: close Discover and
  // hand the source (owner/repo + optional --skill, or a tree URL) to the
  // install wizard's remote staging phase.
  const handleDiscoverInstall = useCallback(
    (source: string, skill?: string) => {
      const profile = workbenchData.profiles[selectedIndex];
      if (!profile) return;
      setDiscoverOpen(false);
      setDiscoverSession(null);
      setWizardProfileName(profile.name);
      setWizardInitialRemote({ source, skill });
    },
    [workbenchData, selectedIndex],
  );

  const handleOpenBrowser = useCallback((url: string) => {
    void openUrlInBrowser(url);
  }, []);

  const closeDiscover = useCallback(() => {
    setDiscoverOpen(false);
    setDiscoverSession(null);
  }, []);

  const wizardCallbacks = useMemo((): InstallWizardCallbacks => {
    // Shared prologue for the install-side callbacks (issue #89): each one
    // resolves the same app-home/profile-root pair for the wizard's profile.
    const wizardContext = () => {
      const appHomePath = getAppHomePaths().appHomePath;
      const { profilesPath } = getAppHomePaths(appHomePath);
      const profileRootPath = path.join(profilesPath, wizardProfileName!);
      return { appHomePath, profileRootPath };
    };
    return {
      onListLocalSources: async () => {
        const appHomePath = getAppHomePaths().appHomePath;
        return listLocalSkillSources({
          appHomePath,
          excludeProfileName: wizardProfileName ?? undefined,
        });
      },
      onResolveSource: async (sourceInput: string) => validateLocalSkillSource(sourceInput),
      onComputePreview: async (input: {
        sourcePath: string;
        mode: 'copy' | 'link';
        name: string;
      }) => {
        const { profileRootPath } = wizardContext();
        return previewInstall(
          {
            profileRootPath,
            sourcePath: input.sourcePath,
            mode: input.mode,
            name: input.name,
          },
          // Core preview/health strings stay English by default; the wizard's
          // catalog-backed translator localizes them for the confirm step.
          coreTranslator,
        );
      },
      onInstall: async (input: {
        sourcePath: string;
        mode: 'copy' | 'link';
        name: string;
        collisionResolution?: 'rename' | 'replace';
      }) => {
        const { appHomePath, profileRootPath } = wizardContext();
        return installLocalSkill({
          appHomePath,
          profileName: wizardProfileName!,
          profileRootPath,
          sourcePath: input.sourcePath,
          mode: input.mode,
          name: input.name,
          collisionResolution: input.collisionResolution,
        });
      },
      onAcquireRemote: async (input: { rawSource: string; skill?: string }) => {
        const { appHomePath, profileRootPath } = wizardContext();
        return acquireAndPreviewRemoteInstall(
          {
            appHomePath,
            profileName: wizardProfileName!,
            profileRootPath,
            rawSource: input.rawSource,
            skill: input.skill,
            // name omitted: derived from the staged Skill's directory name
            // (its frontmatter name) — the remote wizard has no name-input step.
          },
          coreTranslator,
        );
      },
      onInstallRemote: async (input: {
        stagingRoot: string;
        stagedName: string;
        name: string;
        provenanceSource: RemoteInstallPreview['provenanceSource'];
        collisionResolution?: 'rename' | 'replace';
      }) => {
        const { appHomePath, profileRootPath } = wizardContext();
        return installRemoteSkill({
          appHomePath,
          profileName: wizardProfileName!,
          profileRootPath,
          name: input.name,
          stagingRoot: input.stagingRoot,
          stagedName: input.stagedName,
          provenanceSource: input.provenanceSource,
          collisionResolution: input.collisionResolution,
        });
      },
      onCleanupStaging: (stagingRoot: string) => {
        fs.remove(stagingRoot).catch(() => {
          // cleanup failure is non-fatal
        });
      },
      onClose: () => {
        setWizardProfileName(null);
        setWizardInitialRemote(null);
      },
      onInstalled: () => {
        // Refresh data so the Skills count updates after a successful install.
        const appHomePath = getAppHomePaths().appHomePath;
        loadWorkbenchData(appHomePath)
          .then((freshData) => setWorkbenchData(freshData))
          .catch(() => {
            // refresh failure is non-fatal
          });
      },
    };
  }, [wizardProfileName]);

  return {
    wizardProfileName,
    wizardInitialRemote,
    wizardOpen,
    discoverActive,
    discoverSession,
    wizardCallbacks,
    handleAddSkill,
    openDiscover,
    handleDiscoverInstall,
    closeDiscover,
    handleOpenBrowser,
  };
}
