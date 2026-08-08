import { describe, expect, it } from 'vitest';

import { createProgram } from '../src/cli';

describe('entry model (issue #54)', () => {
  it('tui command is registered with updated description', () => {
    const program = createProgram();
    const help = program.helpInformation();
    expect(help).toContain('tui');
    expect(help).toContain('Workbench');
  });

  it('help still shows all existing commands (frozen CLI surface)', () => {
    const program = createProgram();
    const help = program.helpInformation();

    const expectedCommands = [
      'init',
      'create',
      'list',
      'show',
      'validate',
      'backup',
      'copy',
      'rename',
      'remove',
      'default',
      'tui',
      'edit',
      'launch',
      'create-profile',
    ];

    for (const cmd of expectedCommands) {
      expect(help).toContain(cmd);
    }
  });
});
