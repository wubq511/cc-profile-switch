import React from 'react';

import { getProfileTemplatePaths } from '../../core/profile-template';
import { restorePluginItem, type PluginInventory } from '../../core/plugins';
import { type RecoveryBinItem } from '../../core/recovery-bin';
import { type CaptureProcess } from '../../platform/process';
import { type EditSessionManager } from '../../core/edit-session';
import { type DrillDown } from './hooks/use-drill-down';
import { type WorkbenchProfile } from './profile-data';
import { AutoMemoryView } from './resources/auto-memory-view';
import { BulkOpsView } from './resources/bulk-ops-view';
import { SettingsView } from './resources/settings-view';
import { PluginsView } from './resources/plugins-view';
import { RecoveryView } from './resources/recovery-view';

type DrillSurfaceProps = {
  drillDown: DrillDown;
  selectedProfile: WorkbenchProfile | undefined;
  appHomePath: string;
  profileNames: string[];
  pluginInventory: PluginInventory | undefined;
  editSessionManager: EditSessionManager;
  width: number;
  height: number;
  headless?: boolean;
  captureProcess?: CaptureProcess;
  onBack: () => void;
  onDataChanged: () => void;
  onDiscover: () => void;
  /** The default main surface (MainPane element), rendered when no drill is
   *  active — or when a profile-scoped drill has no selected Profile. */
  children: React.ReactElement;
};

/** The main-pane drill surface (issue #69/#83/#94/#101): recovery bin, Auto
 *  Memory, bulk-ops, key-level settings editor, and the read-only plugins
 *  inventory each replace the category grid while drilled in. Extracted from
 *  app.tsx (issue #89); pure presentation — every view owns its own input. */
export function DrillSurface({
  drillDown,
  selectedProfile,
  appHomePath,
  profileNames,
  pluginInventory,
  editSessionManager,
  width,
  height,
  headless,
  captureProcess,
  onBack,
  onDataChanged,
  onDiscover,
  children,
}: DrillSurfaceProps): React.ReactElement {
  if (drillDown.kind === 'recovery') {
    return React.createElement(RecoveryView, {
      appHomePath,
      profileNames,
      width,
      height,
      onBack,
      onDataChanged,
      pluginRestore: async (item: RecoveryBinItem) => {
        // Plugin items reinstall from their marketplace through the same
        // delegation the CLI wires.
        await restorePluginItem({ item, appHomePath, captureProcess });
      },
      headless,
    });
  }
  if (drillDown.kind === 'autoMemory' && selectedProfile) {
    return React.createElement(AutoMemoryView, {
      profile: selectedProfile,
      appHomePath,
      profileNames,
      width,
      height,
      editSessionManager,
      onBack,
    });
  }
  if (drillDown.kind === 'bulk' && selectedProfile) {
    return React.createElement(BulkOpsView, {
      profile: selectedProfile,
      appHomePath,
      profileRootPath: getProfileTemplatePaths(appHomePath, selectedProfile.name).profileRootPath,
      profileNames,
      category: drillDown.category,
      width,
      height,
      onBack,
      onDataChanged,
      onDiscover,
      captureProcess,
      headless,
    });
  }
  if (drillDown.kind === 'kv' && selectedProfile) {
    return React.createElement(SettingsView, {
      profile: selectedProfile,
      appHomePath,
      category: drillDown.category,
      width,
      height,
      onBack,
      onDataChanged,
      initialKey: drillDown.focusKey,
      headless,
    });
  }
  if (drillDown.kind === 'plugins' && selectedProfile) {
    return React.createElement(PluginsView, {
      profile: selectedProfile,
      inventory: pluginInventory,
      width,
      height,
      onBack,
      headless,
    });
  }
  return children;
}
