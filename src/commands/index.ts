import { Command } from 'commander';
import fs from 'fs-extra';
import { createInterface } from 'node:readline/promises';

import { getAppHomePaths, loadAppConfig } from '../core/app-config';
import { listBackups, restoreProfileFromBackup } from '../core/backup';
import { buildLaunchPlan, formatLaunchDryRun, launchProfile } from '../core/launcher';
import { backupProfile, createProfile, initProfiles, type Clock } from '../core/profile';
import { ensureProfileCreator } from '../core/profile-creator';
import { exportProfile } from '../core/profile-export';
import {
  importProfile,
  type ImportConfirmDecision,
  type ImportPreview,
  type ImportResult,
} from '../core/profile-import';
import {
  clearDefaultProfile,
  copyProfile,
  getDefaultProfile,
  removeProfile,
  renameProfile,
  setDefaultProfile,
} from '../core/profile-management';
import { getProfileTemplatePaths } from '../core/profile-template';
import {
  addMarketplace,
  disablePlugin,
  enablePlugin,
  getPluginDetails,
  installPlugin,
  listAvailablePlugins,
  listMarketplaces,
  listPlugins,
  removeMarketplace,
  restorePluginItem,
  uninstallPlugin,
  updateMarketplace,
  updatePlugin,
} from '../core/plugins';
import {
  changeRetentionSetting,
  emptyRecoveryBin,
  formatBytes,
  getRecoveryItem,
  listRecoveryBinWithSizes,
  permanentlyDeleteItem,
  restoreRecoveryItem,
  runStartupSweep,
  type CollisionResolution,
} from '../core/recovery-bin';
import { validateProfile, type ValidationFinding } from '../core/validator';
import { openWithDefaultEditor, type OpenTarget } from '../platform/editor';
import {
  captureProcess as defaultCaptureProcess,
  spawnProcess,
  type CaptureProcess,
  type SpawnProcess,
} from '../platform/process';
import { isPathInside, relativeFilesystemPath, resolveFilesystemPath } from '../platform/path';
import type { PluginCoordinates } from '../schemas/plugins';
import {
  profileConfigSchema,
  profileTemplateSchema,
  type ProfileTemplateName,
} from '../schemas/profile';
import { runTerminalTui, type RunTerminalTuiOptions } from '../tui/terminal';
import { CcpsError } from '../utils/errors';
import { isNodeError } from '../utils/type-guards';

export type CommandRuntime = {
  writeOut: (value: string) => void;
  readInput: (prompt: string) => Promise<string>;
  runTui: (options: Pick<RunTerminalTuiOptions, 'appHomePath'>) => Promise<void>;
  openTarget: OpenTarget;
  spawnProcess: SpawnProcess;
  captureProcess: CaptureProcess;
  clock: Clock;
};

export function registerCommands(program: Command, options: Partial<CommandRuntime> = {}): void {
  const runtime: CommandRuntime = {
    ...defaultRuntime,
    ...options,
  };

  // Spec §9.4: lazy Recovery Bin sweep on every ccps startup (any command),
  // which also reconciles §7.1 transaction crash states. Runs once per
  // invocation before the command action, fully failure-isolated so a sweep
  // problem never blocks or breaks the command. When a previous sweep deleted
  // something, its one-line summary (count + space reclaimed) prints here.
  program.hook('preAction', async () => {
    const report = await runStartupSweep(getAppHomePaths().appHomePath, runtime.clock);
    if (report.pendingSummary !== null) {
      runtime.writeOut(`${report.pendingSummary}\n`);
    }
  });

  program
    .command('init')
    .description('Create the ccps app home and default profiles.')
    .action(async () => {
      const result = await initProfiles({ clock: runtime.clock });
      const created =
        result.createdProfiles.length > 0 ? result.createdProfiles.join(', ') : 'none';
      const preserved =
        result.preservedProfiles.length > 0 ? result.preservedProfiles.join(', ') : 'none';

      runtime.writeOut(`Initialized ccps app home: ${result.appHomePath}\n`);
      runtime.writeOut(`Created default profiles: ${created}\n`);
      runtime.writeOut(`Preserved existing profiles: ${preserved}\n`);
      if (result.apiSettingsImport.importedKeys.length > 0) {
        runtime.writeOut(
          `Imported API env keys: ${result.apiSettingsImport.importedKeys.join(', ')}\n`,
        );
      }
      runtime.writeOut('Next: ccps list\n');
    });

  program
    .command('create <name>')
    .description('Create a profile. Optionally specify a template; defaults to a blank profile.')
    .option(
      '--template <template>',
      'Profile template to use (coding, study, work, research, general).',
    )
    .action(async (name: string, options: { template?: string }) => {
      const template = parseTemplateName(options.template);
      const result = await createProfile({ name, template, clock: runtime.clock });

      const label = result.template ?? 'blank';
      runtime.writeOut(`Created profile "${result.name}" (template: ${label}).\n`);
      runtime.writeOut(`Path: ${result.paths.profileRootPath}\n`);
      runtime.writeOut(`Next: ccps launch ${result.name} --dry-run\n`);
    });

  program
    .command('list')
    .description('List available profiles and their validation status.')
    .action(async () => {
      const appPaths = getAppHomePaths();

      if (
        !(await fs.pathExists(appPaths.appHomePath)) ||
        !(await fs.pathExists(appPaths.profilesPath))
      ) {
        runtime.writeOut(`No ccps app home found: ${appPaths.appHomePath}\n`);
        runtime.writeOut('Next: ccps init\n');
        return;
      }

      const config = await loadAppConfig(appPaths.appHomePath);
      const profileNames = await listProfileNames(appPaths.profilesPath);

      if (profileNames.length === 0) {
        runtime.writeOut(`No profiles found: ${appPaths.profilesPath}\n`);
        runtime.writeOut('Next: ccps init\n');
        return;
      }

      runtime.writeOut(`Profiles in ${appPaths.profilesPath}\n`);
      runtime.writeOut('Name\tStatus\tLast Used\tDescription\n');

      for (const profileName of profileNames) {
        const validation = await validateProfile({
          appHomePath: appPaths.appHomePath,
          name: profileName,
        });
        const description = validation.config?.description ?? '(invalid profile.json)';
        const lastUsed = config.lastUsedProfile === profileName ? 'last-used' : '-';

        runtime.writeOut(`${profileName}\t${validation.status}\t${lastUsed}\t${description}\n`);
      }
    });

  program
    .command('show <name>')
    .description('Display profile structure and file status.')
    .action(async (name: string) => {
      const appPaths = getAppHomePaths();
      const validation = await validateProfile({ appHomePath: appPaths.appHomePath, name });
      const paths = validation.paths;

      runtime.writeOut(`Profile: ${validation.profileName}\n`);
      runtime.writeOut(`Profile path: ${validation.profileRootPath}\n`);
      runtime.writeOut(`Claude home: ${validation.claudeHomePath}\n`);
      runtime.writeOut(`User memory: ${paths.claudeMdPath}\n`);
      runtime.writeOut(`Auto memory: ${paths.autoMemoryPath}\n`);
      runtime.writeOut('Required files:\n');
      runtime.writeOut(`  profile.json: ${await pathStatus(paths.profileConfigPath, 'file')}\n`);
      runtime.writeOut(`  CLAUDE.md: ${await pathStatus(paths.claudeMdPath, 'file')}\n`);
      runtime.writeOut(`  settings.json: ${await jsonStatus(paths.settingsPath)}\n`);
      runtime.writeOut(
        `  MEMORY.md: ${await pathStatus(paths.autoMemoryEntrypointPath, 'file')}\n`,
      );
      runtime.writeOut('Profile directories:\n');
      runtime.writeOut(`  claude-home: ${await pathStatus(paths.claudeHomePath, 'directory')}\n`);
      runtime.writeOut(`  memory: ${await pathStatus(paths.memoryPath, 'directory')}\n`);
      runtime.writeOut(`  memory/auto: ${await pathStatus(paths.autoMemoryPath, 'directory')}\n`);
      runtime.writeOut(`  skills: ${await pathStatus(paths.skillsPath, 'directory')}\n`);
      runtime.writeOut(`  agents: ${await pathStatus(paths.agentsPath, 'directory')}\n`);
      runtime.writeOut(`  rules: ${await pathStatus(paths.rulesPath, 'directory')}\n`);
      runtime.writeOut(`  plugins: ${await pathStatus(paths.pluginsPath, 'directory')}\n`);
      runtime.writeOut('MCP configuration:\n');
      runtime.writeOut(`  native user scope: ${paths.claudeUserConfigPath}\n`);
      runtime.writeOut('  manage with: claude mcp add --scope user ...\n');
      runtime.writeOut(`  legacy mcp.json: ${await jsonStatus(paths.mcpConfigPath)}\n`);
      runtime.writeOut(`JSON validation: ${validation.status}\n`);
      runtime.writeOut('Project config: preserved from the launch cwd\n');
      runtime.writeOut(
        'Real user config: never copied from or written to the real ~/.claude or ~/.claude.json\n',
      );

      if (validation.findings.length > 0) {
        runtime.writeOut(formatFindings(validation.findings));
      }
    });

  program
    .command('validate <name>')
    .description('Check profile launch readiness: required files, JSON, memory, and launch paths.')
    .action(async (name: string) => {
      const appPaths = getAppHomePaths();
      const validation = await validateProfile({ appHomePath: appPaths.appHomePath, name });

      runtime.writeOut(`Profile: ${validation.profileName}\n`);
      runtime.writeOut(`Status: ${validation.status}\n`);

      if (validation.findings.length === 0) {
        runtime.writeOut('No findings.\n');
      } else {
        runtime.writeOut(formatFindings(validation.findings));
      }
    });

  const backup = program
    .command('backup <name>')
    .description('Copy a profile to a timestamped backup directory.')
    .action(async (name: string) => {
      const result = await backupProfile({ name, clock: runtime.clock });

      runtime.writeOut(`Backup created: ${result.backupPath}\n`);
      runtime.writeOut(`Source profile unchanged: ${result.sourcePath}\n`);
    });

  backup
    .command('list')
    .description('List profile backups with per-entry sizes and a total.')
    .action(async () => {
      const appHomePath = getAppHomePaths().appHomePath;
      const list = await listBackups(appHomePath);

      if (list.entries.length === 0) {
        runtime.writeOut('No backups found.\n');
        return;
      }

      runtime.writeOut(
        `Backups: ${list.entries.length} backup(s), ${formatBytes(list.totalSizeBytes)} total\n`,
      );
      for (const entry of list.entries) {
        runtime.writeOut(`  ${entry.id}\t${formatBytes(entry.sizeBytes)}\n`);
      }
    });

  backup
    .command('restore <backup-id>')
    .description(
      'Restore a profile from a backup. Auto-backs-up current state first and never consumes the backup.',
    )
    .option(
      '--new-name <name>',
      'Restore as a new profile name instead of replacing the recorded profile.',
    )
    .action(async (backupId: string, cmdOptions: { newName?: string }) => {
      const appHomePath = getAppHomePaths().appHomePath;
      const result = await restoreProfileFromBackup({
        appHomePath,
        backupId,
        newName: cmdOptions.newName,
        clock: runtime.clock,
      });

      runtime.writeOut(`Restored profile "${result.restoredProfile}" from backup ${backupId}.\n`);
      if (result.preRestoreBackupPath !== null) {
        runtime.writeOut(`Previous state backed up: ${result.preRestoreBackupPath}\n`);
      }
      runtime.writeOut(`Backup kept: ${result.backupPath}\n`);
      runtime.writeOut(`Next: ccps launch ${result.restoredProfile} --dry-run\n`);
    });

  program
    .command('export <name> <path>')
    .description('Package a profile as a single portable .tar.gz bundle.')
    .option(
      '--include-secrets',
      'Include secret-class values (env.ANTHROPIC_* and MCP env). Writes the file 0600.',
    )
    .action(async (name: string, outputPath: string, options: { includeSecrets?: boolean }) => {
      const result = await exportProfile({
        name,
        outputPath,
        includeSecrets: options.includeSecrets,
        clock: runtime.clock,
      });
      const manifest = result.manifest;

      if (manifest.includeSecrets) {
        runtime.writeOut(
          'WARNING: this bundle contains plaintext credentials; anyone with the file can use the API account.\n',
        );
      }
      runtime.writeOut(`Exported profile "${result.profileName}" to ${result.bundlePath}\n`);

      const strippedKeyCount = countStrippedKeys(result.strippedKeys);
      const secretState = manifest.includeSecrets
        ? manifest.secretsPresent
          ? 'included'
          : 'included (none present)'
        : manifest.secretsStripped
          ? `excluded (${strippedKeyCount} key${strippedKeyCount === 1 ? '' : 's'} stripped)`
          : 'excluded (none present)';
      runtime.writeOut(`Secrets: ${secretState}\n`);
      for (const entry of result.strippedKeys) {
        if (entry.keys.length === 0) {
          continue;
        }
        const serverSuffix =
          entry.scope === 'mcp-env' && entry.mcpServer ? ` (${entry.mcpServer})` : '';
        runtime.writeOut(`  ${entry.file}${serverSuffix}: ${entry.keys.join(', ')}\n`);
      }

      const r = manifest.resources;
      runtime.writeOut(
        `Bundle: ${r.userMemory} user memory, ${r.skills} skills, ${r.agents} agents, ${r.mcpServers} MCP servers\n`,
      );
      if (manifest.mcpServerNames.length > 0) {
        runtime.writeOut(`MCP servers: ${manifest.mcpServerNames.join(', ')}\n`);
      }
      runtime.writeOut(`Exporter: ccps ${manifest.exporterVersion}\n`);
    });

  program
    .command('import <bundle> [target-name]')
    .description('Create a new profile from a portable .tar.gz bundle.')
    .action(async (bundlePath: string, targetName: string | undefined) => {
      const confirm = async (preview: ImportPreview): Promise<ImportConfirmDecision> => {
        runtime.writeOut(formatImportPreview(preview));
        if (preview.collision) {
          const typed = await runtime.readInput(
            `A profile named "${preview.targetName}" already exists. Type a new profile name to import as (or press Enter to abort): `,
          );
          const trimmed = typed.trim();
          if (trimmed.length === 0) {
            return { action: 'abort' };
          }
          // Choosing a new name IS the commitment to proceed (no second y/N).
          // Echo the resolved target so the user sees what will land before the
          // import runs.
          runtime.writeOut(`Import as: ${trimmed}\n`);
          return { action: 'proceed-as-new-name', targetName: trimmed };
        }
        const answer = await runtime.readInput(
          `Proceed with import as "${preview.targetName}"? [y/N]: `,
        );
        return answer.trim().toLowerCase().startsWith('y')
          ? { action: 'proceed' }
          : { action: 'abort' };
      };

      const outcome = await importProfile({
        bundlePath,
        targetName,
        confirm,
        captureProcess: runtime.captureProcess,
        clock: runtime.clock,
      });

      if ('aborted' in outcome) {
        runtime.writeOut('Import aborted.\n');
        return;
      }

      runtime.writeOut(formatImportResult(outcome));
    });

  program
    .command('copy <from> <to>')
    .description('Copy a profile to a new profile name.')
    .action(async (from: string, to: string) => {
      const result = await copyProfile({ from, to, clock: runtime.clock });

      runtime.writeOut(`Copied profile "${result.sourceName}" to "${result.targetName}".\n`);
      runtime.writeOut(`Source: ${result.sourcePath}\n`);
      runtime.writeOut(`Target: ${result.targetPath}\n`);
      runtime.writeOut(`Next: ccps launch ${result.targetName} --dry-run\n`);
    });

  program
    .command('rename <old> <new>')
    .description('Rename a profile and update app config references.')
    .action(async (oldName: string, newName: string) => {
      const appPaths = getAppHomePaths();
      const previousConfig = await loadAppConfig(appPaths.appHomePath);
      const result = await renameProfile({
        appHomePath: appPaths.appHomePath,
        oldName,
        newName,
        clock: runtime.clock,
      });

      runtime.writeOut(`Renamed profile "${result.oldName}" to "${result.newName}".\n`);
      runtime.writeOut(`Path: ${result.newPath}\n`);

      if (previousConfig.defaultProfile === result.oldName) {
        runtime.writeOut(`Updated default profile reference: ${result.newName}\n`);
      }

      if (previousConfig.lastUsedProfile === result.oldName) {
        runtime.writeOut(`Updated last-used profile reference: ${result.newName}\n`);
      }

      runtime.writeOut(`Next: ccps launch ${result.newName} --dry-run\n`);
    });

  program
    .command('remove <name>')
    .description('Remove a profile after exact-name confirmation and backup.')
    .option('--no-backup', 'Skip backup; create a Recovery Item instead.')
    .action(async (name: string, cmdOptions: { noBackup?: boolean }) => {
      const confirmation = await runtime.readInput(
        `Type the exact profile name to remove "${name}": `,
      );
      const result = await removeProfile({
        name,
        confirmation,
        noBackup: cmdOptions.noBackup,
        clock: runtime.clock,
      });

      runtime.writeOut(`Removed profile "${result.profileName}".\n`);
      if (result.backupPath) {
        runtime.writeOut(`Backup: ${result.backupPath}\n`);
      }
      if (result.recoveryItem) {
        runtime.writeOut(`Recovery item: ${result.recoveryItem.id}\n`);
      }
      runtime.writeOut(`Removed path: ${result.removedPath}\n`);
    });

  program
    .command('default [name]')
    .description('Show, set, or clear the default launch profile.')
    .option('--clear', 'Clear the default profile.')
    .action(async (name: string | undefined, options: { clear?: boolean }) => {
      const appPaths = getAppHomePaths();

      if (options.clear) {
        await clearDefaultProfile({
          appHomePath: appPaths.appHomePath,
          clock: runtime.clock,
        });
        runtime.writeOut('Default profile cleared.\n');
        runtime.writeOut('Next: ccps default <profile>\n');
        return;
      }

      if (name === undefined) {
        const defaultProfile = await getDefaultProfile({ appHomePath: appPaths.appHomePath });
        if (defaultProfile === undefined) {
          runtime.writeOut('No default profile set.\n');
          runtime.writeOut('Next: ccps default <profile>\n');
          return;
        }

        runtime.writeOut(`Default profile: ${defaultProfile}\n`);
        runtime.writeOut('Next: ccps launch\n');
        return;
      }

      const defaultProfile = await setDefaultProfile({
        appHomePath: appPaths.appHomePath,
        name,
        clock: runtime.clock,
      });
      runtime.writeOut(`Default profile set: ${defaultProfile}\n`);
      runtime.writeOut('Next: ccps launch\n');
    });

  program
    .command('tui')
    .description('Open the Profile Workbench.')
    .action(async () => {
      // When runTui is injected (test mode), use it directly.
      // This bypasses the TTY check so tests can verify the command routing.
      if (options.runTui !== undefined) {
        const appPaths = getAppHomePaths();
        runtime.writeOut('Starting ccps TUI.\n');
        await runtime.runTui({ appHomePath: appPaths.appHomePath });
        return;
      }

      const isDualTty = process.stdin.isTTY && process.stdout.isTTY;

      if (!isDualTty) {
        throw new CcpsError(
          'TUI_REQUIRES_TTY',
          'Workbench requires an interactive terminal (TTY).',
          { guidance: 'Run ccps tui in a terminal, or use ccps <command> for scripting.' },
        );
      }

      const { launchWorkbench } = await import('../tui/workbench-loader');
      await launchWorkbench();
    });

  program
    .command('edit <name> [file]')
    .description('Open a profile file or directory in a new VS Code window.')
    .action(async (name: string, file?: string) => {
      const appPaths = getAppHomePaths();
      await loadAppConfig(appPaths.appHomePath);

      const targetPath = resolveEditTarget(appPaths.appHomePath, name, file);
      await runtime.openTarget(targetPath);

      runtime.writeOut(`Opened: ${targetPath}\n`);
    });

  program
    .command('launch [profile]')
    .description('Start Claude Code with the selected user-level profile.')
    .option('--dry-run', 'Print the launch plan without starting Claude Code.')
    .option('--cwd <path>', 'Project directory to launch Claude Code from.')
    .action(async (profile: string | undefined, options: { dryRun?: boolean; cwd?: string }) => {
      const appPaths = getAppHomePaths();
      if (options.dryRun) {
        const plan = await buildLaunchPlan({
          appHomePath: appPaths.appHomePath,
          profileName: profile,
          cwd: options.cwd,
        });

        runtime.writeOut(formatLaunchDryRun(plan));
        return;
      }

      const result = await launchProfile({
        appHomePath: appPaths.appHomePath,
        profileName: profile,
        cwd: options.cwd,
        spawnProcess: runtime.spawnProcess,
        clock: runtime.clock,
      });

      runtime.writeOut(`Launching Claude Code with profile "${result.plan.profileName}".\n`);
      runtime.writeOut(`Cwd: ${result.plan.cwd}\n`);
      runtime.writeOut(`CLAUDE_CONFIG_DIR=${result.plan.envChanges.CLAUDE_CONFIG_DIR}\n`);
    });

  program
    .command('create-profile')
    .description('Launch Claude Code with the profile creator wizard.')
    .option('--cwd <path>', 'Project directory to launch Claude Code from.')
    .action(async (options: { cwd?: string }) => {
      const appPaths = getAppHomePaths();

      runtime.writeOut('Setting up profile creator...\n');
      const profileName = await ensureProfileCreator({
        appHomePath: appPaths.appHomePath,
        clock: runtime.clock,
      });
      runtime.writeOut(`Profile creator ready. Launching Claude Code...\n`);

      await launchProfile({
        appHomePath: appPaths.appHomePath,
        profileName,
        cwd: options.cwd,
        spawnProcess: runtime.spawnProcess,
        clock: runtime.clock,
      });

      runtime.writeOut(`Claude Code exited. Profile creator session complete.\n`);
    });

  const plugin = program
    .command('plugin')
    .description('Manage plugins for a profile through the delegated claude plugin CLI.');

  plugin
    .command('list <profile>')
    .description(
      'List installed plugins with enable state, or marketplace-available entries with --available.',
    )
    .option('--available', "List plugins available from the profile's configured marketplaces.")
    .action(async (profile: string, options: { available?: boolean }) => {
      const appHomePath = getAppHomePaths().appHomePath;

      if (options.available) {
        const result = await listAvailablePlugins({
          appHomePath,
          profileName: profile,
          captureProcess: runtime.captureProcess,
        });
        if (result.available.length === 0) {
          runtime.writeOut(`No plugins available for profile "${profile}".\n`);
          return;
        }
        runtime.writeOut(`Available plugins for "${profile}":\n`);
        for (const entry of result.available) {
          runtime.writeOut(`  ${entry.pluginId}\t(${entry.marketplaceName})\n`);
        }
        return;
      }

      const plugins = await listPlugins({
        appHomePath,
        profileName: profile,
        captureProcess: runtime.captureProcess,
      });
      if (plugins.length === 0) {
        runtime.writeOut(`No plugins installed for profile "${profile}".\n`);
        return;
      }
      runtime.writeOut(`Installed plugins for "${profile}":\n`);
      for (const entry of plugins) {
        const state = entry.enabled ? 'enabled' : 'disabled';
        runtime.writeOut(`  ${entry.id}\t${entry.version}\t${state}\n`);
      }
    });

  plugin
    .command('details <profile> <plugin>')
    .description('Show the component inventory for an installed plugin.')
    .action(async (profile: string, selector: string) => {
      const appHomePath = getAppHomePaths().appHomePath;
      const details = await getPluginDetails({
        appHomePath,
        profileName: profile,
        selector,
        captureProcess: runtime.captureProcess,
      });
      runtime.writeOut(details.raw);
      if (!details.raw.endsWith('\n')) {
        runtime.writeOut('\n');
      }
    });

  plugin
    .command('install <profile> <plugin>')
    .description('Install a plugin at user scope.')
    .option('--config <key=value>', 'Set a plugin config value (repeatable).', collectOption, [])
    .action(async (profile: string, selector: string, options: { config: string[] }) => {
      const appHomePath = getAppHomePaths().appHomePath;
      const config: Record<string, string> = {};
      for (const pair of options.config) {
        const eq = pair.indexOf('=');
        if (eq <= 0) {
          throw new CcpsError(
            'PLUGIN_INVALID_CONFIG',
            `Plugin config must be key=value: "${pair}".`,
            {
              guidance: 'Use --config key=value, for example: --config model=fast',
            },
          );
        }
        config[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      await installPlugin({
        appHomePath,
        profileName: profile,
        selector,
        config,
        captureProcess: runtime.captureProcess,
      });
      runtime.writeOut(`Installed ${selector} for profile "${profile}".\n`);
    });

  plugin
    .command('enable <profile> <plugin>')
    .description('Enable an installed plugin.')
    .action(async (profile: string, selector: string) => {
      const appHomePath = getAppHomePaths().appHomePath;
      await enablePlugin({
        appHomePath,
        profileName: profile,
        selector,
        captureProcess: runtime.captureProcess,
      });
      runtime.writeOut(`Enabled ${selector} for profile "${profile}".\n`);
    });

  plugin
    .command('disable <profile> <plugin>')
    .description('Disable an installed plugin.')
    .action(async (profile: string, selector: string) => {
      const appHomePath = getAppHomePaths().appHomePath;
      await disablePlugin({
        appHomePath,
        profileName: profile,
        selector,
        captureProcess: runtime.captureProcess,
      });
      runtime.writeOut(`Disabled ${selector} for profile "${profile}".\n`);
    });

  plugin
    .command('update <profile> <plugin>')
    .description('Update an installed plugin; prints a restart notice when one is required.')
    .action(async (profile: string, selector: string) => {
      const appHomePath = getAppHomePaths().appHomePath;
      const result = await updatePlugin({
        appHomePath,
        profileName: profile,
        selector,
        captureProcess: runtime.captureProcess,
      });
      runtime.writeOut(`Updated ${selector} for profile "${profile}".\n`);
      if (result.restartRequired) {
        runtime.writeOut('Restart to apply changes.\n');
      }
    });

  plugin
    .command('uninstall <profile> <plugin>')
    .description('Uninstall a plugin and create a Recovery Bin item that restores it.')
    .option(
      '--config-key <name>',
      'Record a userConfig key name on the Recovery item (repeatable).',
      collectOption,
      [],
    )
    .action(async (profile: string, selector: string, options: { configKey: string[] }) => {
      const appHomePath = getAppHomePaths().appHomePath;
      const result = await uninstallPlugin({
        appHomePath,
        profileName: profile,
        selector,
        userConfigKeys: options.configKey,
        captureProcess: runtime.captureProcess,
      });
      runtime.writeOut(`Uninstalled ${selector} for profile "${profile}".\n`);
      runtime.writeOut(`Recovery item: ${result.binItem.id}\n`);
      if (options.configKey.length > 0) {
        runtime.writeOut(
          `Config keys to re-enter after restore: ${options.configKey.join(', ')}\n`,
        );
      }
    });

  const marketplace = plugin
    .command('marketplace')
    .description('Manage marketplaces for a profile.');

  marketplace
    .command('list <profile>')
    .description('List configured marketplaces from profile settings and the resolved cache.')
    .action(async (profile: string) => {
      const appHomePath = getAppHomePaths().appHomePath;
      const entries = await listMarketplaces({ appHomePath, profileName: profile });
      if (entries.length === 0) {
        runtime.writeOut(`No marketplaces configured for profile "${profile}".\n`);
        return;
      }
      runtime.writeOut(`Marketplaces for "${profile}":\n`);
      for (const entry of entries) {
        const source =
          entry.sourceKind === 'directory' && entry.sourcePath
            ? entry.sourcePath
            : (entry.sourceUrl ?? entry.sourceKind);
        runtime.writeOut(`  ${entry.name}\t${source}\n`);
      }
    });

  marketplace
    .command('add <profile> <source>')
    .description('Add a marketplace: owner/repo, https://…, or a local directory path.')
    .action(async (profile: string, source: string) => {
      const appHomePath = getAppHomePaths().appHomePath;
      await addMarketplace({
        appHomePath,
        profileName: profile,
        source,
        captureProcess: runtime.captureProcess,
      });
      runtime.writeOut(`Added marketplace from "${source}" for profile "${profile}".\n`);
    });

  marketplace
    .command('update <profile> <name>')
    .description('Refresh a configured marketplace.')
    .action(async (profile: string, name: string) => {
      const appHomePath = getAppHomePaths().appHomePath;
      await updateMarketplace({
        appHomePath,
        profileName: profile,
        name,
        captureProcess: runtime.captureProcess,
      });
      runtime.writeOut(`Updated marketplace "${name}" for profile "${profile}".\n`);
    });

  marketplace
    .command('remove <profile> <name>')
    .description('Remove a configured marketplace.')
    .action(async (profile: string, name: string) => {
      const appHomePath = getAppHomePaths().appHomePath;
      await removeMarketplace({
        appHomePath,
        profileName: profile,
        name,
        captureProcess: runtime.captureProcess,
      });
      runtime.writeOut(`Removed marketplace "${name}" for profile "${profile}".\n`);
    });

  const bin = program.command('bin').description('Inspect and restore Recovery Bin items.');

  bin
    .command('list')
    .description('List Recovery Bin items with per-entry sizes and a total.')
    .action(async () => {
      const appHomePath = getAppHomePaths().appHomePath;
      const list = await listRecoveryBinWithSizes(appHomePath);

      if (list.entries.length === 0) {
        runtime.writeOut('Recovery Bin is empty.\n');
        return;
      }

      runtime.writeOut(
        `Recovery Bin: ${list.entries.length} item(s), ${formatBytes(list.totalSizeBytes)} total\n`,
      );
      for (const entry of list.entries) {
        runtime.writeOut(
          `  ${entry.item.id}\t${entry.item.profile}\t${entry.item.kind}\t${formatBytes(entry.sizeBytes)}\n`,
        );
      }
    });

  bin
    .command('remove <item-id>')
    .description('Permanently delete one Recovery Bin item; this cannot be undone.')
    .option('--yes', 'Skip the confirmation prompt.')
    .action(async (itemId: string, cmdOptions: { yes?: boolean }) => {
      const appHomePath = getAppHomePaths().appHomePath;
      const item = await getRecoveryItem(itemId, appHomePath);

      if (!cmdOptions.yes) {
        const answer = await runtime.readInput(
          `Permanently delete Recovery Bin item "${item.id}" (profile "${item.profile}", ${item.kind})? This is permanent and unrecoverable. [y/N]: `,
        );
        if (!answer.trim().toLowerCase().startsWith('y')) {
          runtime.writeOut('Aborted.\n');
          return;
        }
      }

      await permanentlyDeleteItem(itemId, appHomePath);
      runtime.writeOut(`Permanently deleted Recovery Bin item "${item.id}".\n`);
    });

  bin
    .command('empty')
    .description('Permanently delete ALL Recovery Bin items; this cannot be undone.')
    .option('--yes', 'Skip the confirmation prompt.')
    .action(async (cmdOptions: { yes?: boolean }) => {
      const appHomePath = getAppHomePaths().appHomePath;
      const list = await listRecoveryBinWithSizes(appHomePath);

      if (list.entries.length === 0) {
        runtime.writeOut('Recovery Bin is already empty.\n');
        return;
      }

      if (!cmdOptions.yes) {
        const answer = await runtime.readInput(
          `Permanently delete ALL ${list.entries.length} Recovery Bin item(s) (${formatBytes(list.totalSizeBytes)} total)? This is permanent and unrecoverable. [y/N]: `,
        );
        if (!answer.trim().toLowerCase().startsWith('y')) {
          runtime.writeOut('Aborted.\n');
          return;
        }
      }

      await emptyRecoveryBin(appHomePath);
      runtime.writeOut(`Permanently deleted ${list.entries.length} Recovery Bin item(s).\n`);
    });

  bin
    .command('retention [days]')
    .description(
      'Show or set Recovery Bin retention (7, 30, 90 days, or never). A change reports how many existing items would expire under it.',
    )
    .action(async (days: string | undefined) => {
      const appHomePath = getAppHomePaths().appHomePath;

      if (days === undefined) {
        const config = await loadAppConfig(appHomePath);
        const current = config.recovery.retentionDays;
        const label = current === null ? 'never (items never expire)' : `${current} days`;
        runtime.writeOut(`Recovery Bin retention: ${label}\n`);
        runtime.writeOut('Change: ccps bin retention 7|30|90|never\n');
        return;
      }

      const retentionDays = parseRetentionDays(days);
      const impact = await changeRetentionSetting(retentionDays, appHomePath, runtime.clock);
      const label = retentionDays === null ? 'never' : `${retentionDays} days`;
      runtime.writeOut(`Recovery Bin retention set to ${label}.\n`);
      runtime.writeOut(
        `${impact.wouldExpireCount} existing item(s) would expire under this setting.\n`,
      );
    });

  bin
    .command('restore <item-id>')
    .description(
      'Restore a Recovery Bin item; consumes it on success. Plugin items reinstall from their marketplace.',
    )
    .option(
      '--resolve <mode>',
      'Collision resolution for file-tree/fragment items: refuse, restore-as-new-name, delete-and-restore.',
      'refuse',
    )
    .option(
      '--new-name <name>',
      'New name for the restored resource when --resolve restore-as-new-name (entry rename; new Profile name for profile-kind items).',
    )
    .action(async (itemId: string, options: { resolve?: string; newName?: string }) => {
      const appHomePath = getAppHomePaths().appHomePath;
      const result = await restoreRecoveryItem({
        appHomePath,
        itemId,
        collisionResolution: parseCollisionResolution(options.resolve),
        newName: options.newName,
        pluginRestore: async (item) => {
          const coords = item.coordinates as PluginCoordinates;
          const outcome = await restorePluginItem({
            item,
            appHomePath,
            captureProcess: runtime.captureProcess,
          });
          runtime.writeOut(
            `Restored ${coords.plugin}@${coords.marketplace} version ${outcome.installedVersion} (marketplace current).\n`,
          );
          if (outcome.reenabled) {
            runtime.writeOut('Re-enabled plugin.\n');
          }
          if (outcome.userConfigKeys.length > 0) {
            runtime.writeOut(`Re-enter these config keys: ${outcome.userConfigKeys.join(', ')}\n`);
          }
        },
      });
      runtime.writeOut(`Restored item for profile "${result.restoredProfile}".\n`);
    });
}

export const registerPlaceholderCommands = registerCommands;

const defaultRuntime: CommandRuntime = {
  writeOut: (value) => {
    process.stdout.write(value);
  },
  readInput: async (prompt) => {
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      return await readline.question(prompt);
    } finally {
      readline.close();
    }
  },
  runTui: runTerminalTui,
  openTarget: openWithDefaultEditor,
  spawnProcess,
  captureProcess: defaultCaptureProcess,
  clock: () => new Date(),
};

function parseTemplateName(value: string | undefined): ProfileTemplateName | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = profileTemplateSchema.safeParse(value);

  if (!parsed.success) {
    throw new CcpsError('INVALID_PROFILE_TEMPLATE', 'Profile template is not supported.', {
      guidance: 'Use one of: coding, study, work, research, general.',
      cause: parsed.error,
    });
  }

  return parsed.data;
}

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parseCollisionResolution(value: string | undefined): CollisionResolution {
  if (value === 'refuse' || value === 'restore-as-new-name' || value === 'delete-and-restore') {
    return value;
  }

  throw new CcpsError('INVALID_COLLISION_RESOLUTION', 'Unknown collision resolution mode.', {
    guidance: 'Use one of: refuse, restore-as-new-name, delete-and-restore.',
  });
}

function parseRetentionDays(value: string): 7 | 30 | 90 | null {
  if (value === '7' || value === '30' || value === '90') {
    return Number(value) as 7 | 30 | 90;
  }

  if (value.toLowerCase() === 'never') {
    return null;
  }

  throw new CcpsError('INVALID_RETENTION_DAYS', 'Recovery Bin retention is not supported.', {
    guidance: 'Use one of: 7, 30, 90, never.',
  });
}

function resolveEditTarget(appHomePath: string, name: string, file?: string): string {
  const paths = getProfileTemplatePaths(appHomePath, name);

  if (!fs.pathExistsSync(paths.profileRootPath)) {
    throw new CcpsError('PROFILE_NOT_FOUND', 'Profile does not exist.', {
      guidance: `Create the profile first: ccps create ${name}`,
    });
  }

  if (file === undefined) {
    return paths.profileRootPath;
  }

  const aliasTarget = editTargetAliases(paths)[normalizeEditTargetKey(file)];
  const targetPath = aliasTarget ?? resolveFilesystemPath(paths.profileRootPath, file);

  if (
    !isPathInside(paths.profileRootPath, targetPath) ||
    hasSensitivePathSegment(paths.profileRootPath, targetPath)
  ) {
    throw invalidEditTarget();
  }

  if (!fs.pathExistsSync(targetPath)) {
    throw new CcpsError('EDIT_TARGET_NOT_FOUND', 'Edit target does not exist.', {
      guidance: `Open the profile folder or choose an existing file or directory under: ${paths.profileRootPath}`,
    });
  }

  const realProfileRootPath = fs.realpathSync(paths.profileRootPath);
  const realTargetPath = fs.realpathSync(targetPath);
  const targetStats = fs.statSync(realTargetPath);
  if (
    !isPathInside(realProfileRootPath, realTargetPath) ||
    (!targetStats.isFile() && !targetStats.isDirectory())
  ) {
    throw invalidEditTarget();
  }

  return targetPath;
}

function editTargetAliases(
  paths: ReturnType<typeof getProfileTemplatePaths>,
): Record<string, string> {
  return {
    'claude.md': paths.claudeMdPath,
    'settings.json': paths.settingsPath,
    'mcp.json': paths.mcpConfigPath,
    'profile.json': paths.profileConfigPath,
    'claude-home': paths.claudeHomePath,
    memory: paths.memoryPath,
    'memory\\auto': paths.autoMemoryPath,
    skills: paths.skillsPath,
    agents: paths.agentsPath,
    rules: paths.rulesPath,
    plugins: paths.pluginsPath,
  };
}

function normalizeEditTargetKey(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase();
}

function hasSensitivePathSegment(profileRootPath: string, targetPath: string): boolean {
  return relativeFilesystemPath(profileRootPath, targetPath)
    .split(/[\\/]+/)
    .some((segment) => /(oauth|tokens?|secrets?|credentials?)/i.test(segment));
}

function invalidEditTarget(): CcpsError {
  return new CcpsError('INVALID_EDIT_TARGET', 'Edit target is not approved.', {
    guidance:
      'Use an existing path inside the selected profile. Credential-like paths such as token, secret, credential, or oauth are blocked.',
  });
}

async function listProfileNames(profilesPath: string): Promise<string[]> {
  const entries = await fs.readdir(profilesPath, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function pathStatus(targetPath: string, expectedType: 'file' | 'directory'): Promise<string> {
  try {
    const stats = await fs.stat(targetPath);

    if (expectedType === 'file' && stats.isFile()) {
      return 'present';
    }

    if (expectedType === 'directory' && stats.isDirectory()) {
      return 'present';
    }

    return 'wrong type';
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return 'missing';
    }

    throw error;
  }
}

async function jsonStatus(targetPath: string): Promise<string> {
  const present = await pathStatus(targetPath, 'file');
  if (present !== 'present') {
    return present;
  }

  try {
    const value = await fs.readJson(targetPath);
    if (targetPath.endsWith('profile.json')) {
      return profileConfigSchema.safeParse(value).success ? 'valid JSON' : 'invalid schema';
    }

    return 'valid JSON';
  } catch {
    return 'invalid JSON';
  }
}

function formatFindings(findings: ValidationFinding[]): string {
  const lines = ['Findings:'];

  for (const finding of findings) {
    const pathSuffix = finding.path ? ` (${finding.path})` : '';
    lines.push(`  [${finding.severity}] ${finding.code}: ${finding.message}${pathSuffix}`);
    if (finding.suggestion) {
      lines.push(`    Next: ${finding.suggestion}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function countStrippedKeys(entries: { keys: string[] }[]): number {
  return entries.reduce((sum, entry) => sum + entry.keys.length, 0);
}

function formatImportPreview(preview: ImportPreview): string {
  const m = preview.manifest;
  const r = m.resources;
  const lines: string[] = [];

  lines.push(
    `Bundle: ccps profile-bundle (exporter ccps ${m.exporterVersion}, exported ${m.exportedAt})`,
  );
  lines.push(`Source profile: ${m.profileName}`);
  lines.push(`Import as: ${preview.targetName}${preview.collision ? ' (NAME EXISTS)' : ''}`);
  lines.push(
    `Resources: ${r.userMemory} user memory, ${r.autoMemory} auto memory, ${r.skills} skills, ${r.agents} agents, ${r.mcpServers} MCP servers, ${r.settings} settings, ${r.launchConfig} launch config`,
  );
  if (m.mcpServerNames.length > 0) {
    lines.push(`MCP servers: ${m.mcpServerNames.join(', ')}`);
  }
  lines.push(`Secrets: ${describeImportSecrets(m)}`);
  return `${lines.join('\n')}\n`;
}

function describeImportSecrets(manifest: ImportPreview['manifest']): string {
  if (manifest.includeSecrets) {
    return manifest.secretsPresent ? 'included (plaintext)' : 'included (none present)';
  }
  if (manifest.secretsStripped) {
    const count = countStrippedKeys(manifest.strippedKeys);
    return `excluded (${count} key${count === 1 ? '' : 's'} stripped, re-enter after import)`;
  }
  return 'excluded (none present)';
}

function formatImportResult(result: ImportResult): string {
  const lines: string[] = [];
  lines.push(`Imported profile "${result.profileName}" to ${result.profileRootPath}`);

  const ok = result.mcpServers.filter((s) => s.reRegistered).map((s) => s.name);
  const failed = result.mcpServers.filter((s) => !s.reRegistered);
  if (ok.length > 0) {
    lines.push(`MCP servers re-registered: ${ok.join(', ')}`);
  }
  for (const f of failed) {
    lines.push(`MCP server "${f.name}" failed: ${f.failureMessage ?? 'unknown error'}`);
  }
  const envReentry = result.mcpServers
    .filter((s) => s.envKeysToReenter.length > 0)
    .map((s) => `${s.name} (${s.envKeysToReenter.join(', ')})`);
  if (envReentry.length > 0) {
    lines.push(`MCP env keys to re-enter: ${envReentry.join('; ')}`);
  }
  if (result.settingsSecretKeysToReenter.length > 0) {
    lines.push(
      `Secrets to re-enter in settings.json: ${result.settingsSecretKeysToReenter.join(', ')}`,
    );
  }
  for (const legacy of result.legacyMcpEnvKeysToReenter) {
    lines.push(
      `Legacy mcp.json env keys to re-enter (${legacy.server}): ${legacy.keys.join(', ')}`,
    );
  }

  lines.push(`Validation: ${result.validation.status}`);
  if (result.validation.findings.length > 0) {
    lines.push(formatFindings(result.validation.findings).trimEnd());
  }
  lines.push(`Next: ccps launch ${result.profileName} --dry-run`);
  return `${lines.join('\n')}\n`;
}
