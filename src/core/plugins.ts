import fs from 'fs-extra';

import { getAppHomePaths } from './app-config';
import { getProfileTemplatePaths } from './profile-template';
import { isOfflineFailure } from './skills-acquisition';
import { captureProcess as defaultCaptureProcess, type CaptureProcess } from '../platform/process';
import { resolveFilesystemPath } from '../platform/path';
import {
  installedPluginListSchema,
  availablePluginListSchema,
  type AvailablePlugin,
  type InstalledPlugin,
  type MarketplaceEntry,
  type PluginComponentCounts,
  type PluginCoordinates,
  type PluginDetails,
} from '../schemas/plugins';
import { createPluginItem, type RecoveryBinItem } from './recovery-bin';
import { CcpsError } from '../utils/errors';
import { isNodeError, isRecord } from '../utils/type-guards';

export const PLUGIN_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

// ─── Delegation plan ────────────────────────────────────────────────────

export type PluginCommandPlan = {
  command: string;
  args: string[];
  cwd: string;
  envChanges: {
    CLAUDE_CONFIG_DIR: string;
  };
  claudeHomePath: string;
};

/**
 * Pure plan builder: resolves the profile's claude-home and delegates to the
 * `claude plugin` CLI with CLAUDE_CONFIG_DIR set. No filesystem side effects,
 * so dry-run ≡ real run.
 */
export function buildPluginCommandPlan(options: {
  appHomePath: string;
  profileName: string;
  args: string[];
}): PluginCommandPlan {
  const paths = getProfileTemplatePaths(options.appHomePath, options.profileName);
  return {
    command: 'claude',
    args: ['plugin', ...options.args],
    cwd: paths.claudeHomePath,
    envChanges: { CLAUDE_CONFIG_DIR: paths.claudeHomePath },
    claudeHomePath: paths.claudeHomePath,
  };
}

// ─── Runner ─────────────────────────────────────────────────────────────

export type RunPluginCommandOptions = {
  appHomePath: string;
  profileName: string;
  args: string[];
  captureProcess?: CaptureProcess;
  timeoutMs?: number;
};

export type RunPluginCommandResult = {
  plan: PluginCommandPlan;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export async function runPluginCommand(
  options: RunPluginCommandOptions,
): Promise<RunPluginCommandResult> {
  const plan = buildPluginCommandPlan(options);
  await assertProfileExists(options.appHomePath, options.profileName);
  const run = options.captureProcess ?? defaultCaptureProcess;

  let result;
  try {
    result = await run(plan.command, plan.args, {
      cwd: plan.cwd,
      shell: false,
      env: { ...process.env, ...plan.envChanges },
      timeoutMs: options.timeoutMs ?? PLUGIN_COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    throw new CcpsError('PLUGIN_CLI_UNAVAILABLE', 'Failed to start the claude CLI.', {
      guidance: 'Confirm Claude Code is installed and available on PATH, then retry the operation.',
      cause: error,
    });
  }

  if (result.timedOut) {
    throw new CcpsError(
      'PLUGIN_COMMAND_TIMEOUT',
      'The claude plugin command did not finish before the timeout.',
      {
        guidance: 'Retry the operation; plugin install and update can be slow on large marketplaces.',
      },
    );
  }

  if (result.exitCode === 0) {
    return { plan, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  if (isOfflineFailure(result.stdout, result.stderr)) {
    throw new CcpsError(
      'PLUGIN_COMMAND_OFFLINE',
      'The plugin operation could not reach its source over the network.',
      {
        guidance: 'Check the network connection and retry the operation when online.',
      },
    );
  }

  throw new CcpsError(
    'PLUGIN_COMMAND_FAILED',
    `The claude plugin command failed (exit ${String(result.exitCode)}).`,
    {
      guidance: `Review the claude CLI diagnostics, then retry. ${summarizeOutput(result.stderr, result.stdout)}`,
    },
  );
}

// ─── Browse ─────────────────────────────────────────────────────────────

export type BrowsePluginsOptions = {
  appHomePath: string;
  profileName: string;
  captureProcess?: CaptureProcess;
};

export async function listPlugins(
  options: BrowsePluginsOptions,
): Promise<InstalledPlugin[]> {
  const result = await runPluginCommand({ ...options, args: ['list', '--json'] });
  return parseInstalledPlugins(result.stdout);
}

// ─── Workbench read-only inventory (issue #96, spec §7.6) ────────────────

export type PluginInventoryEntry = {
  /** Plugin selector (plugin@marketplace) — names/status only, never values. */
  id: string;
  enabled: boolean;
};

export type PluginInventory =
  | { status: 'ok'; plugins: PluginInventoryEntry[] }
  | { status: 'unavailable' };

/**
 * Fail-closed inventory read backing the Workbench's read-only Plugins card.
 * Delegates to `claude plugin list --json` with CLAUDE_CONFIG_DIR set, then
 * keeps only names + enable state (version, install paths, timestamps are
 * dropped). Never throws: an unavailable CLI degrades to an 'unavailable'
 * status so the card can never break the Workbench.
 */
export async function readPluginInventory(
  options: BrowsePluginsOptions,
): Promise<PluginInventory> {
  try {
    const plugins = await listPlugins(options);
    return {
      status: 'ok',
      plugins: plugins.map((plugin) => ({ id: plugin.id, enabled: plugin.enabled })),
    };
  } catch {
    return { status: 'unavailable' };
  }
}

export type AvailablePluginsResult = {
  installed: InstalledPlugin[];
  available: AvailablePlugin[];
};

export async function listAvailablePlugins(
  options: BrowsePluginsOptions,
): Promise<AvailablePluginsResult> {
  const result = await runPluginCommand({ ...options, args: ['list', '--available', '--json'] });
  const raw = parseJson(result.stdout);
  if (!isRecord(raw) || !Array.isArray(raw.installed) || !Array.isArray(raw.available)) {
    throw invalidPluginListOutput();
  }
  const installed = installedPluginListSchema.safeParse(raw.installed);
  const available = availablePluginListSchema.safeParse(raw.available);
  if (!installed.success || !available.success) {
    throw invalidPluginListOutput();
  }
  return { installed: installed.data, available: available.data };
}

export async function getPluginDetails(
  options: BrowsePluginsOptions & { selector: string },
): Promise<PluginDetails> {
  const result = await runPluginCommand({ ...options, args: ['details', options.selector] });
  return { raw: result.stdout, components: parseComponentInventory(result.stdout) };
}

export async function listMarketplaces(options: {
  appHomePath: string;
  profileName: string;
}): Promise<MarketplaceEntry[]> {
  const paths = getProfileTemplatePaths(options.appHomePath, options.profileName);
  const settings = await readJsonIfPresent(paths.settingsPath);
  const known = await readJsonIfPresent(
    resolveFilesystemPath(paths.claudeHomePath, 'plugins', 'known_marketplaces.json'),
  );

  const byName = new Map<string, MarketplaceEntry>();

  if (isRecord(settings)) {
    const extra = isRecord(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {};
    for (const [name, value] of Object.entries(extra)) {
      const source = isRecord(value) && isRecord(value.source) ? value.source : {};
      byName.set(name, toMarketplaceEntry(name, source));
    }
  }

  if (isRecord(known)) {
    for (const [name, value] of Object.entries(known)) {
      const source = isRecord(value) && isRecord(value.source) ? value.source : {};
      const entry = toMarketplaceEntry(name, source);
      if (isRecord(value)) {
        if (typeof value.installLocation === 'string') entry.installLocation = value.installLocation;
        if (typeof value.lastUpdated === 'string') entry.lastUpdated = value.lastUpdated;
      }
      // The resolved metadata cache is authoritative over the declaration.
      byName.set(name, entry);
    }
  }

  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

// ─── Mutations ──────────────────────────────────────────────────────────

export type MutatePluginOptions = {
  appHomePath: string;
  profileName: string;
  selector: string;
  captureProcess?: CaptureProcess;
};

export async function installPlugin(
  options: MutatePluginOptions & { config?: Record<string, string> },
): Promise<RunPluginCommandResult> {
  const args = ['install', options.selector, '--scope', 'user'];
  for (const [key, value] of Object.entries(options.config ?? {})) {
    args.push('--config', `${key}=${value}`);
  }
  return runPluginCommand({ ...options, args });
}

export function enablePlugin(options: MutatePluginOptions): Promise<RunPluginCommandResult> {
  return runPluginCommand({ ...options, args: ['enable', options.selector] });
}

export function disablePlugin(options: MutatePluginOptions): Promise<RunPluginCommandResult> {
  return runPluginCommand({ ...options, args: ['disable', options.selector] });
}

export type UpdatePluginResult = RunPluginCommandResult & { restartRequired: boolean };

export async function updatePlugin(options: MutatePluginOptions): Promise<UpdatePluginResult> {
  const result = await runPluginCommand({ ...options, args: ['update', options.selector] });
  return { ...result, restartRequired: detectRestartRequired(result.stdout, result.stderr) };
}

export type UninstallPluginOptions = MutatePluginOptions & {
  /** Names of userConfig keys the plugin used, for the restore reminder. Values are never read. */
  userConfigKeys?: string[];
};

export type UninstallPluginResult = {
  result: RunPluginCommandResult;
  binItem: RecoveryBinItem;
};

export async function uninstallPlugin(
  options: UninstallPluginOptions,
): Promise<UninstallPluginResult> {
  const { plugin, marketplace } = parsePluginSelector(options.selector);

  // Capture the authoritative enable state through the delegated CLI before
  // uninstalling (the record's `enabled` is re-applied on restore).
  const plugins = await listPlugins({
    appHomePath: options.appHomePath,
    profileName: options.profileName,
    captureProcess: options.captureProcess,
  });
  const enabled = plugins.find((entry) => entry.id === options.selector)?.enabled ?? false;

  const result = await runPluginCommand({ ...options, args: ['uninstall', options.selector] });

  const binItem = await createPluginItem({
    appHomePath: options.appHomePath,
    origin: 'remove',
    profile: options.profileName,
    coordinates: {
      plugin,
      marketplace,
      enabled,
      userConfigKeys: options.userConfigKeys ?? [],
    },
  });

  return { result, binItem };
}

export type MarketplaceSourceOptions = {
  appHomePath: string;
  profileName: string;
  captureProcess?: CaptureProcess;
};

export async function addMarketplace(
  options: MarketplaceSourceOptions & { source: string },
): Promise<RunPluginCommandResult> {
  const validated = validateMarketplaceSource(options.source);
  return runPluginCommand({ ...options, args: ['marketplace', 'add', validated] });
}

export function updateMarketplace(
  options: MarketplaceSourceOptions & { name: string },
): Promise<RunPluginCommandResult> {
  return runPluginCommand({ ...options, args: ['marketplace', 'update', options.name] });
}

export function removeMarketplace(
  options: MarketplaceSourceOptions & { name: string },
): Promise<RunPluginCommandResult> {
  return runPluginCommand({ ...options, args: ['marketplace', 'remove', options.name] });
}

// ─── Restore (Recovery Bin plugin item) ─────────────────────────────────

export type RestorePluginItemOptions = {
  item: RecoveryBinItem;
  appHomePath?: string;
  captureProcess?: CaptureProcess;
};

export type RestorePluginItemResult = {
  installedVersion: string;
  reenabled: boolean;
  userConfigKeys: string[];
};

/**
 * Restores a plugin uninstall record: checks the marketplace is still
 * configured, reinstalls the current marketplace version, re-applies the
 * recorded enable state, and surfaces config key names for re-entry.
 * Plugin credential values are never read or written.
 */
export async function restorePluginItem(
  options: RestorePluginItemOptions,
): Promise<RestorePluginItemResult> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  const coords = options.item.coordinates as PluginCoordinates;
  const profile = options.item.profile;

  if (!coords.marketplace) {
    throw new CcpsError(
      'PLUGIN_MARKETPLACE_MISSING',
      'The plugin record has no marketplace to restore from.',
      {
        guidance: 'Reinstall the plugin from its marketplace manually.',
      },
    );
  }

  const marketplaces = await listMarketplaces({ appHomePath, profileName: profile });
  if (!marketplaces.some((entry) => entry.name === coords.marketplace)) {
    throw new CcpsError(
      'PLUGIN_MARKETPLACE_MISSING',
      `Marketplace "${coords.marketplace}" is not configured for profile "${profile}".`,
      {
        guidance: `Add the marketplace first: ccps plugin marketplace add ${profile} <source>`,
      },
    );
  }

  const selector = `${coords.plugin}@${coords.marketplace}`;
  const capture = options.captureProcess;

  await installPlugin({ appHomePath, profileName: profile, selector, captureProcess: capture });

  // Re-apply the recorded enable state. Install enables by default, so only
  // issue enable/disable when the current state differs (avoids an
  // "already enabled/disabled" upstream error failing the restore).
  const installed = await listPlugins({ appHomePath, profileName: profile, captureProcess: capture });
  const entry = installed.find((plugin) => plugin.id === selector);

  if (!entry) {
    throw new CcpsError(
      'PLUGIN_RESTORE_UNVERIFIED',
      `The reinstall of "${selector}" did not produce a registered plugin.`,
      {
        guidance: 'The Recovery item is retained; verify the plugin install, then retry the restore.',
      },
    );
  }

  let reenabled = false;
  if (coords.enabled && !entry.enabled) {
    await enablePlugin({ appHomePath, profileName: profile, selector, captureProcess: capture });
    reenabled = true;
  } else if (!coords.enabled && entry.enabled) {
    await disablePlugin({ appHomePath, profileName: profile, selector, captureProcess: capture });
  }

  return {
    installedVersion: entry.version,
    reenabled,
    userConfigKeys: coords.userConfigKeys,
  };
}

// ─── Pure helpers ───────────────────────────────────────────────────────

export function parsePluginSelector(selector: string): { plugin: string; marketplace: string } {
  const at = selector.lastIndexOf('@');
  if (at <= 0 || at === selector.length - 1) {
    throw new CcpsError('PLUGIN_INVALID_SELECTOR', 'A plugin selector must be plugin@marketplace.', {
      guidance: 'Provide the plugin and marketplace, for example: probe-plugin@probe-marketplace',
    });
  }
  return { plugin: selector.slice(0, at), marketplace: selector.slice(at + 1) };
}

export function validateMarketplaceSource(source: string): string {
  if (source.startsWith('file://')) {
    throw new CcpsError(
      'PLUGIN_MARKETPLACE_FILE_URL_REJECTED',
      'file:// marketplace sources are rejected.',
      {
        guidance: 'Use owner/repo, an https://… URL, or an existing local directory path.',
      },
    );
  }

  // Non-file URL schemes (https://, git://, ssh://, …) pass through to the CLI.
  if (SCHEME_PATTERN.test(source)) {
    return source;
  }

  // owner/repo shorthand — a local directory with the same shape wins if present.
  const segments = source.split('/');
  const isOwnerRepo =
    !source.includes('\\') &&
    !source.startsWith('/') &&
    segments.length === 2 &&
    segments.every((segment) => segment.length > 0 && !segment.startsWith('.'));

  if (isOwnerRepo) {
    const resolved = resolveFilesystemPath(source);
    if (fs.pathExistsSync(resolved)) {
      return resolved;
    }
    return source;
  }

  // Everything else must be an existing local path (absolute or ./relative).
  const resolved = resolveFilesystemPath(source);
  if (fs.pathExistsSync(resolved)) {
    return resolved;
  }

  throw new CcpsError(
    'PLUGIN_MARKETPLACE_INVALID_SOURCE',
    `"${source}" is not a valid marketplace source.`,
    {
      guidance: 'Use owner/repo, an https://… URL, or an existing local directory path.',
    },
  );
}

export function detectRestartRequired(stdout: string, stderr: string): boolean {
  // Matches both the probed "Restart to apply changes." and variants like
  // "Restart required to apply changes.".
  return /restart[^.\n]*to apply/i.test(`${stdout}\n${stderr}`);
}

export function parseInstalledPlugins(stdout: string): InstalledPlugin[] {
  const raw = parseJson(stdout);
  if (!Array.isArray(raw)) {
    throw invalidPluginListOutput();
  }
  const parsed = installedPluginListSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalidPluginListOutput();
  }
  return parsed.data;
}

export function parseComponentInventory(output: string): PluginComponentCounts | null {
  const lines = stripAnsi(output).split('\n');
  const start = lines.findIndex((line) => line.trim() === 'Component inventory');
  if (start === -1) {
    return null;
  }

  const counts: Partial<PluginComponentCounts> = {};
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed === '') break;
    const match = /^(.+?)\s+\((\d+)\)$/.exec(trimmed);
    if (!match) break;
    const key = COMPONENT_KEY_BY_LABEL[match[1]];
    if (key) {
      counts[key] = parseInt(match[2], 10);
    }
  }

  if (counts.skills === undefined) {
    return null;
  }

  return {
    skills: counts.skills ?? 0,
    agents: counts.agents ?? 0,
    hooks: counts.hooks ?? 0,
    mcpServers: counts.mcpServers ?? 0,
    lspServers: counts.lspServers ?? 0,
  };
}

// ─── Internal helpers ───────────────────────────────────────────────────

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

const COMPONENT_KEY_BY_LABEL: Record<string, keyof PluginComponentCounts> = {
  Skills: 'skills',
  Agents: 'agents',
  Hooks: 'hooks',
  'MCP servers': 'mcpServers',
  'LSP servers': 'lspServers',
};

async function assertProfileExists(appHomePath: string, profileName: string): Promise<void> {
  const profileRootPath = getProfileTemplatePaths(appHomePath, profileName).profileRootPath;
  if (!(await fs.pathExists(profileRootPath))) {
    throw new CcpsError('PROFILE_NOT_FOUND', 'Profile does not exist.', {
      guidance: `Create the profile first: ccps create ${profileName}`,
    });
  }
}

function toMarketplaceEntry(name: string, source: Record<string, unknown>): MarketplaceEntry {
  const kind = typeof source.source === 'string' ? source.source : '';
  const sourceKind = kind === 'directory' || kind === 'git' ? kind : 'unknown';
  const sourcePath = typeof source.path === 'string' ? source.path : undefined;
  const sourceUrl = typeof source.url === 'string' ? source.url : undefined;
  return { name, sourceKind, sourcePath, sourceUrl };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(stripAnsi(text).trim());
  } catch {
    throw invalidPluginListOutput();
  }
}

function invalidPluginListOutput(): CcpsError {
  return new CcpsError(
    'PLUGIN_LIST_INVALID_OUTPUT',
    'The claude plugin CLI returned output ccps could not parse.',
    {
      guidance: 'Confirm the installed claude CLI is compatible, then retry.',
    },
  );
}

async function readJsonIfPresent(filePath: string): Promise<unknown | undefined> {
  try {
    return await fs.readJson(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function summarizeOutput(...chunks: string[]): string {
  const combined = chunks
    .flatMap((chunk) => chunk.split('\n'))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => stripAnsi(line));
  const tail = combined.slice(-3).join(' | ');
  return tail.length > 0 ? `claude CLI said: ${tail}` : 'The claude CLI produced no output.';
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}
