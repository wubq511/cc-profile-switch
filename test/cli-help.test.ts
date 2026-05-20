import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createProgram } from '../src/cli';

describe('ccps help', () => {
  it('shows the expected command overview', () => {
    const program = createProgram();

    const help = program.helpInformation();

    expect(help).toContain('CC-Profile-Switch');
    expect(help).toContain('Usage: ccps');
    expect(help).toContain('init');
    expect(help).toContain('copy');
    expect(help).toContain('rename');
    expect(help).toContain('remove');
    expect(help).toContain('default');
    expect(help).toContain('tui');
    expect(help).toContain('launch');
    expect(help).toContain('[profile]');
  });

  it('does not create profile files when displaying help', () => {
    const userProfile = mkdtempSync(join(tmpdir(), 'ccps-help-'));
    const originalUserProfile = process.env.USERPROFILE;
    const output: string[] = [];

    process.env.USERPROFILE = userProfile;

    try {
      const program = createProgram();
      program.configureOutput({
        writeOut: (value) => output.push(value),
        writeErr: (value) => output.push(value),
      });
      program.exitOverride();

      expect(() => program.parse(['node', 'ccps', '--help'], { from: 'user' })).toThrow(
        expect.objectContaining({ code: 'commander.helpDisplayed' }),
      );

      expect(output.join('')).toContain('Usage: ccps');
      expect(existsSync(join(userProfile, '.cc-profile-switch'))).toBe(false);
    } finally {
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      rmSync(userProfile, { recursive: true, force: true });
    }
  });
});
