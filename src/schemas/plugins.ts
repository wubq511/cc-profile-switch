import { z } from 'zod';

// ─── Installed plugin (claude plugin list --json) ────────────────────────
// Probed against claude 2.1.220:
// [{ id, version, scope: 'user', enabled: boolean, installPath, installedAt, lastUpdated }]
// Tolerant parse: upstream output may gain fields; unknown keys pass through.
export const installedPluginSchema = z
  .object({
    id: z.string().min(1),
    version: z.string(),
    scope: z.string().default('user'),
    enabled: z.boolean().default(false),
    installPath: z.string().optional(),
    installedAt: z.string().optional(),
    lastUpdated: z.string().optional(),
  })
  .passthrough();

export const installedPluginListSchema = z.array(installedPluginSchema);

export type InstalledPlugin = z.infer<typeof installedPluginSchema>;

// ─── Available plugin (claude plugin list --available --json) ────────────
// Probed shape: { installed: [], available: [{ pluginId, name, marketplaceName, source }] }
export const availablePluginSchema = z
  .object({
    pluginId: z.string().min(1),
    name: z.string(),
    marketplaceName: z.string(),
    source: z.string(),
  })
  .passthrough();

export const availablePluginListSchema = z.array(availablePluginSchema);

export type AvailablePlugin = z.infer<typeof availablePluginSchema>;

// ─── Marketplace inventory (profile settings.json + known_marketplaces.json) ──
// settings.json: extraKnownMarketplaces[name] = { source: { source, path|url, ... } }
// known_marketplaces.json: { name: { source, installLocation, lastUpdated } }
export const marketplaceSourceSchema = z
  .object({
    source: z.string(),
    path: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

export const knownMarketplaceSchema = z
  .object({
    source: marketplaceSourceSchema.optional(),
    installLocation: z.string().optional(),
    lastUpdated: z.string().optional(),
  })
  .passthrough();

export const knownMarketplacesSchema = z.record(z.string(), knownMarketplaceSchema);

// A normalized marketplace entry surfaced by ccps.
export type MarketplaceEntry = {
  name: string;
  sourceKind: 'directory' | 'git' | 'unknown';
  sourcePath?: string;
  sourceUrl?: string;
  installLocation?: string;
  lastUpdated?: string;
};

// ─── Plugin details (claude plugin details) ───────────────────────────────
// Probed output includes a "Component inventory" block:
//   Component inventory
//     Skills (n) / Agents (n) / Hooks (n) / MCP servers (n) / LSP servers (n)
export type PluginComponentCounts = {
  skills: number;
  agents: number;
  hooks: number;
  mcpServers: number;
  lspServers: number;
};

export type PluginDetails = {
  raw: string;
  components: PluginComponentCounts | null;
};

// ─── Recovery Bin coordinates for a plugin uninstall ─────────────────────
// Records plugin@marketplace, enable state, and the names of any userConfig
// keys the caller captured. Values are never stored or read (acceptance #6).
export const pluginCoordinatesSchema = z
  .object({
    plugin: z.string().min(1),
    marketplace: z.string().default(''),
    enabled: z.boolean(),
    userConfigKeys: z.array(z.string()).default([]),
  })
  .strict();

export type PluginCoordinates = z.infer<typeof pluginCoordinatesSchema>;
