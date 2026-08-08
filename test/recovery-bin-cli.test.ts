import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProgram } from '../src/cli';
import { getAppHomePaths, loadAppConfig } from '../src/core/app-config';
import { createFileTreeItem, listRecoveryBinItems } from '../src/core/recovery-bin';

/**
 * CLI wiring for spec §9.2–§9.5: the startup sweep and its next-launch
 * summary, retention changes with impact reporting, size-bearing Bin/Backup
 * listings, permanent deletion with the lightweight confirmation, and
 * restore-from-Backup.
 */

type CliRun = {
  output: string;
};

describe('Recovery Bin and Backup CLI wiring', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeUserHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-bin-cli-'));
    tempRoots.push(root);
    return root;
  }

  const fixedClock = () => new Date('2026-08-01T12:00:00Z');

  async function runCli(
    userHome: string,
    args: string[],
    options: {
      clock?: () => Date;
      promptInputs?: string[];
      prompts?: string[];
    } = {},
  ): Promise<CliRun> {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const output: string[] = [];
    const program = createProgram({
      writeOut: (value) => output.push(value),
      openTarget: async () => {},
      spawnProcess: async () => ({ exitCode: 0 }),
      readInput: async (prompt) => {
        options.prompts?.push(prompt);
        return options.promptInputs?.shift() ?? '';
      },
      runTui: async () => {},
      clock: options.clock ?? fixedClock,
    });
    program.configureOutput({
      writeOut: (value) => output.push(value),
      writeErr: (value) => output.push(value),
    });

    process.env.HOME = userHome;
    process.env.USERPROFILE = userHome;
    program.exitOverride();

    try {
      await program.parseAsync(['node', 'ccps', ...args], { from: 'node' });
      return { output: output.join('') };
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
    }
  }

  function appHomeOf(userHome: string): string {
    return join(userHome, '.cc-profile-switch');
  }

  /** Create an expired (2026-06-01) skill item in the bin of the given home. */
  async function makeBinItem(
    userHome: string,
    removedAt = '2026-06-01T10:00:00Z',
  ): Promise<string> {
    const appHome = appHomeOf(userHome);
    const { profilesPath } = getAppHomePaths(appHome);
    const skillDir = join(profilesPath, 'coding', 'claude-home', 'skills', 'pdf');
    await fs.ensureDir(skillDir);
    await fs.writeFile(join(skillDir, 'SKILL.md'), 'x'.repeat(1000), 'utf8');

    const item = await createFileTreeItem({
      appHomePath: appHome,
      origin: 'remove',
      kind: 'skill',
      profile: 'coding',
      coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
      sourcePath: skillDir,
      clock: () => new Date(removedAt),
    });
    return item.id;
  }

  // ─── §9.4 startup sweep ───────────────────────────────────────────────

  describe('startup sweep (§9.4)', () => {
    it('sweeps expired items on any command and prints one line on the next launch', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init']);
      await makeBinItem(userHome);

      // The command that triggers the sweep does NOT print the summary; the
      // deleted item is simply gone from the listing.
      const swept = await runCli(userHome, ['bin', 'list']);
      expect(swept.output).not.toContain('swept');
      expect(swept.output).toContain('Recovery Bin is empty.');

      // The next launch prints the one-line summary (count + space reclaimed).
      const next = await runCli(userHome, ['list']);
      expect(next.output).toContain('Recovery Bin: 1 expired item(s) swept');
      expect(next.output).toContain('reclaimed');

      // And the line prints exactly once.
      const after = await runCli(userHome, ['list']);
      expect(after.output).not.toContain('swept');
    });

    it('prints no sweep summary when a sweep deleted nothing', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init']);

      const first = await runCli(userHome, ['list']);
      const second = await runCli(userHome, ['list']);

      expect(first.output).not.toContain('swept');
      expect(second.output).not.toContain('swept');
    });

    it('never breaks the command when the sweep cannot run', async () => {
      const userHome = await makeUserHome();

      // Uninitialized app home: the sweep fails internally, the command runs.
      const result = await runCli(userHome, ['list']);

      expect(result.output).toContain('No ccps app home found');
    });

    it('does not run the sweep for --help and does not create the app home', async () => {
      const userHome = await makeUserHome();

      await expect(runCli(userHome, ['--help'])).rejects.toMatchObject({
        code: 'commander.helpDisplayed',
      });
      expect(await fs.pathExists(join(userHome, '.cc-profile-switch'))).toBe(false);
    });
  });

  // ─── §9.4 retention setting ───────────────────────────────────────────

  describe('bin retention (§9.4)', () => {
    it('shows the current retention with no argument', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init']);

      const result = await runCli(userHome, ['bin', 'retention']);

      expect(result.output).toContain('Recovery Bin retention: 30 days');
      expect(result.output).toContain('ccps bin retention 7|30|90|never');
    });

    it('changes the setting and reports how many existing items would expire', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init']);
      // Ten days old: alive under the default 30-day retention (so the
      // pre-action sweep keeps it), expired under 7 days.
      await makeBinItem(userHome, '2026-07-22T10:00:00Z');

      const result = await runCli(userHome, ['bin', 'retention', '7']);

      expect(result.output).toContain('Recovery Bin retention set to 7 days.');
      expect(result.output).toContain('1 existing item(s) would expire under this setting.');

      const config = await loadAppConfig(appHomeOf(userHome));
      expect(config.recovery.retentionDays).toBe(7);
    });

    it('supports never for no expiry', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init']);

      const result = await runCli(userHome, ['bin', 'retention', 'never']);

      expect(result.output).toContain('Recovery Bin retention set to never.');
      expect(result.output).toContain('0 existing item(s) would expire under this setting.');

      const config = await loadAppConfig(appHomeOf(userHome));
      expect(config.recovery.retentionDays).toBeNull();
    });

    it('rejects an unsupported retention value', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init']);

      await expect(runCli(userHome, ['bin', 'retention', '14'])).rejects.toMatchObject({
        code: 'INVALID_RETENTION_DAYS',
      });
    });
  });

  // ─── §9.5 Bin listing sizes ───────────────────────────────────────────

  describe('bin list sizes (§9.5)', () => {
    it('shows per-entry sizes inline with a total at the top', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init']);
      const itemId = await makeBinItem(userHome, '2026-07-31T10:00:00Z');

      const result = await runCli(userHome, ['bin', 'list']);

      const lines = result.output.split('\n');
      expect(lines[0]).toMatch(/^Recovery Bin: 1 item\(s\), \d+(\.\d+)? (B|KB|MB) total$/);
      const itemLine = lines.find((line) => line.includes(itemId));
      expect(itemLine).toBeDefined();
      expect(itemLine).toContain('\tcoding\tskill\t');
      expect(itemLine).toMatch(/\d+(\.\d+)? (B|KB|MB)$/);
    });
  });

  // ─── §9.5 permanent deletion ──────────────────────────────────────────

  describe('bin remove (§9.5)', () => {
    it('confirms with copy that states the deletion is permanent and unrecoverable', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init']);
      const itemId = await makeBinItem(userHome, '2026-07-31T10:00:00Z');
      const prompts: string[] = [];

      const result = await runCli(userHome, ['bin', 'remove', itemId], {
        promptInputs: ['n'],
        prompts,
      });

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('permanent and unrecoverable');
      expect(result.output).toContain('Aborted.');
      expect(await listRecoveryBinItems(appHomeOf(userHome))).toHaveLength(1);
    });

    it('deletes the item after confirmation', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init']);
      const itemId = await makeBinItem(userHome, '2026-07-31T10:00:00Z');

      const result = await runCli(userHome, ['bin', 'remove', itemId], {
        promptInputs: ['y'],
      });

      expect(result.output).toContain(`Permanently deleted Recovery Bin item "${itemId}".`);
      expect(await listRecoveryBinItems(appHomeOf(userHome))).toHaveLength(0);
    });

    it('skips the confirmation prompt with --yes', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init']);
      const itemId = await makeBinItem(userHome, '2026-07-31T10:00:00Z');
      const prompts: string[] = [];

      const result = await runCli(userHome, ['bin', 'remove', itemId, '--yes'], { prompts });

      expect(prompts).toHaveLength(0);
      expect(result.output).toContain('Permanently deleted');
      expect(await listRecoveryBinItems(appHomeOf(userHome))).toHaveLength(0);
    });

    it('rejects an unknown item id', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init']);

      await expect(runCli(userHome, ['bin', 'remove', 'no-such-item'])).rejects.toMatchObject({
        code: 'RECOVERY_ITEM_NOT_FOUND',
      });
    });
  });

  describe('bin empty (§9.5)', () => {
    it('empties the bin after a permanent and unrecoverable confirmation', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init']);
      await makeBinItem(userHome, '2026-07-31T10:00:00Z');
      await makeBinItem(userHome, '2026-07-30T10:00:00Z');
      const prompts: string[] = [];

      const result = await runCli(userHome, ['bin', 'empty'], {
        promptInputs: ['y'],
        prompts,
      });

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('ALL 2 Recovery Bin item(s)');
      expect(prompts[0]).toContain('permanent and unrecoverable');
      expect(result.output).toContain('Permanently deleted 2 Recovery Bin item(s).');
      expect(await listRecoveryBinItems(appHomeOf(userHome))).toHaveLength(0);
    });

    it('leaves the bin untouched when the confirmation is declined', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init']);
      await makeBinItem(userHome, '2026-07-31T10:00:00Z');

      const result = await runCli(userHome, ['bin', 'empty'], { promptInputs: ['n'] });

      expect(result.output).toContain('Aborted.');
      expect(await listRecoveryBinItems(appHomeOf(userHome))).toHaveLength(1);
    });

    it('skips the prompt on an already-empty bin', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init']);
      const prompts: string[] = [];

      const result = await runCli(userHome, ['bin', 'empty'], { prompts });

      expect(result.output).toContain('Recovery Bin is already empty.');
      expect(prompts).toHaveLength(0);
    });
  });

  // ─── §9.5/§6.2 Backup listing and restore ─────────────────────────────

  describe('backup list (§9.5)', () => {
    it('lists backups with per-entry sizes and a total', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init']);
      await runCli(userHome, ['backup', 'coding']);

      const result = await runCli(userHome, ['backup', 'list']);

      const lines = result.output.split('\n');
      expect(lines[0]).toMatch(/^Backups: 1 backup\(s\), \d+(\.\d+)? (B|KB|MB) total$/);
      expect(result.output).toContain('coding-20260801-120000');
      const backupLine = lines.find((line) => line.includes('coding-20260801-120000'));
      expect(backupLine).toMatch(/\d+(\.\d+)? (B|KB|MB)$/);
    });

    it('reports when no backups exist', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init']);

      const result = await runCli(userHome, ['backup', 'list']);

      expect(result.output).toContain('No backups found.');
    });
  });

  describe('backup restore (§6.2, §9.2, §9.3)', () => {
    const backupClock = () => new Date('2026-08-01T12:00:00Z');
    const restoreClock = () => new Date('2026-08-02T09:15:00Z');

    it('auto-backs-up current state first, restores the backup, and never consumes it', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init'], { clock: backupClock });
      await runCli(userHome, ['backup', 'coding'], { clock: backupClock });

      const appHome = appHomeOf(userHome);
      const { profilesPath, backupsPath } = getAppHomePaths(appHome);
      const claudeMdPath = join(profilesPath, 'coding', 'claude-home', 'CLAUDE.md');
      const backupClaudeMd = await fs.readFile(
        join(backupsPath, 'coding-20260801-120000', 'claude-home', 'CLAUDE.md'),
        'utf8',
      );
      await fs.writeFile(claudeMdPath, 'MUTATED STATE', 'utf8');

      const result = await runCli(
        userHome,
        ['backup', 'restore', 'coding-20260801-120000'],
        { clock: restoreClock },
      );

      expect(result.output).toContain('Restored profile "coding" from backup coding-20260801-120000.');
      expect(result.output).toContain('Previous state backed up:');
      expect(result.output).toContain('Backup kept:');

      // Current state was auto-backed-up before the replace.
      const safetyClaudeMd = await fs.readFile(
        join(backupsPath, 'coding-20260802-091500', 'claude-home', 'CLAUDE.md'),
        'utf8',
      );
      expect(safetyClaudeMd).toBe('MUTATED STATE');

      // The profile now holds the backup content; the backup itself survives.
      await expect(fs.readFile(claudeMdPath, 'utf8')).resolves.toBe(backupClaudeMd);
      expect(await fs.pathExists(join(backupsPath, 'coding-20260801-120000'))).toBe(true);
    });

    it('restores as a new profile with --new-name', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init'], { clock: backupClock });
      await runCli(userHome, ['backup', 'coding'], { clock: backupClock });

      const result = await runCli(
        userHome,
        ['backup', 'restore', 'coding-20260801-120000', '--new-name', 'coding-copy'],
        { clock: restoreClock },
      );

      expect(result.output).toContain('Restored profile "coding-copy"');
      const { profilesPath } = getAppHomePaths(appHomeOf(userHome));
      expect(await fs.pathExists(join(profilesPath, 'coding-copy', 'profile.json'))).toBe(true);
      expect(await fs.pathExists(join(profilesPath, 'coding', 'profile.json'))).toBe(true);
    });

    it('refuses a missing backup', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init']);

      await expect(
        runCli(userHome, ['backup', 'restore', 'coding-20990101-000000']),
      ).rejects.toMatchObject({ code: 'BACKUP_NOT_FOUND' });
    });
  });
});
