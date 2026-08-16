import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { getAppHomePaths } from '../../../core/app-config';
import { listMcpServers, type McpServerState } from '../../../core/mcp-list';
import { readPluginInventory, type PluginInventory } from '../../../core/plugins';
import type { CaptureProcess } from '../../../platform/process';
import type { WorkbenchData } from '../profile-data';

type UseProfileProbesOptions = {
  workbenchData: WorkbenchData;
  selectedIndex: number;
  setWorkbenchData: Dispatch<SetStateAction<WorkbenchData>>;
  /** Override the MCP connection-state probe (tests). */
  mcpProbe?: (appHomePath: string, profileName: string) => Promise<McpServerState[]>;
  /** Override the Plugins inventory read (tests, #96). */
  pluginInventoryReader?: (
    appHomePath: string,
    profileName: string,
  ) => Promise<PluginInventory>;
  /** Injected process capture for the plugin inventory read (hermetic tests). */
  captureProcess?: CaptureProcess;
};

type UseProfileProbesResult = {
  /** MCP servers that failed to connect, keyed by profile name (amber nudge §5). */
  mcpFailedByProfile: Record<string, string[]>;
  /** Read-only Plugins inventory cache keyed by profile name (§7.6, #96). */
  pluginInventoryByProfile: Record<string, PluginInventory>;
  /** Drop the plugin inventory cache so the next probe re-reads (refreshData). */
  clearPluginInventory: () => void;
};

/** Just-in-time per-profile probes extracted from app.tsx (issue #89): the MCP
 *  connection-state nudge and the read-only Plugins inventory card. Both are
 *  fail-closed — a hung or missing `claude` CLI never blocks the Workbench. */
export function useProfileProbes({
  workbenchData,
  selectedIndex,
  setWorkbenchData,
  mcpProbe,
  pluginInventoryReader,
  captureProcess,
}: UseProfileProbesOptions): UseProfileProbesResult {
  const [mcpFailedByProfile, setMcpFailedByProfile] = useState<Record<string, string[]>>({});
  // Read-only Plugins status card (issue #96, §7.6): lazily-read inventory
  // cached per profile name, fail-closed so an unavailable `claude` CLI never
  // blocks the Workbench. Cleared by refreshData so the card re-reads after
  // an in-Workbench change (e.g. a Recovery plugin restore).
  const [pluginInventoryByProfile, setPluginInventoryByProfile] = useState<
    Record<string, PluginInventory>
  >({});
  // Read-guard mirror of the state above, held in a ref so the read effect can
  // consult it without re-triggering on its own writes. Only successful reads
  // are recorded here: an 'unavailable' result is transient (a hung `claude
  // plugin list` can time out), so the next profile switch re-probes instead
  // of pinning the failure for the whole session.
  const pluginInventoryRef = useRef<Record<string, PluginInventory>>({});

  const clearPluginInventory = useCallback(() => {
    setPluginInventoryByProfile({});
    pluginInventoryRef.current = {};
  }, []);

  // Just-in-time MCP nudge: probe the selected Profile's MCP connection state
  // once per session (cached by profile name), fail closed on any error.
  useEffect(() => {
    const profile = workbenchData.profiles[selectedIndex];
    if (!profile || (profile.mcpServers?.length ?? 0) === 0) return;
    if (mcpFailedByProfile[profile.name]) return; // already probed this session

    let cancelled = false;
    const probe =
      mcpProbe ??
      ((appHomePath: string, name: string) => listMcpServers({ appHomePath, profileName: name }));
    (async () => {
      try {
        const states = await probe(getAppHomePaths().appHomePath, profile.name);
        if (cancelled) return;
        const failed = states.filter((s) => s.failed).map((s) => s.name);
        setMcpFailedByProfile((prev) => ({ ...prev, [profile.name]: failed }));
      } catch {
        // fail closed — no nudge
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedIndex, workbenchData.profiles, mcpFailedByProfile, mcpProbe]);

  // Read-only Plugins inventory (§7.6, issue #96): probe the selected
  // Profile's installed plugins once per data refresh (cached by name).
  // `readPluginInventory` is the single fail-closed boundary — it never
  // throws. Only 'ok' results are stored: the card renders the unavailable
  // message fail-closed while pending, so a failed probe is a render-free
  // no-op and is never cached, letting the next probe (profile switch or
  // refresh) retry.
  useEffect(() => {
    const profile = workbenchData.profiles[selectedIndex];
    if (!profile) return;
    if (pluginInventoryRef.current[profile.name]) return; // already read

    let cancelled = false;
    const reader =
      pluginInventoryReader ??
      ((appHomePath: string, profileName: string) =>
        readPluginInventory({ appHomePath, profileName, captureProcess }));
    (async () => {
      const inventory = await reader(getAppHomePaths().appHomePath, profile.name);
      if (cancelled) return;
      if (inventory.status !== 'ok') return; // card already shows unavailable
      setPluginInventoryByProfile((prev) => ({ ...prev, [profile.name]: inventory }));
      pluginInventoryRef.current = { ...pluginInventoryRef.current, [profile.name]: inventory };
      // Merge into the workbench data so the Plugins grid card and sidebar
      // tree rows see the inventory as a regular category (issue #101 L4).
      setWorkbenchData((prev) =>
        prev
          ? {
              ...prev,
              profiles: prev.profiles.map((p) =>
                p.name === profile.name
                  ? {
                      ...p,
                      resourceCounts: { ...p.resourceCounts, plugins: inventory.plugins.length },
                      resourceDetails: {
                        ...p.resourceDetails,
                        plugins: inventory.plugins.map((entry) => entry.id),
                      },
                    }
                  : p,
              ),
            }
          : prev,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedIndex, workbenchData.profiles, pluginInventoryReader, captureProcess, setWorkbenchData]);

  return { mcpFailedByProfile, pluginInventoryByProfile, clearPluginInventory };
}
