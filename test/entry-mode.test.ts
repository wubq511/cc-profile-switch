import { describe, expect, it } from 'vitest';

import { resolveEntryMode } from '../src/entry-mode';

describe('resolveEntryMode (issue #54 §3.1)', () => {
  it('bare dual-TTY invocation opens the Workbench', () => {
    expect(resolveEntryMode([], true)).toBe('workbench');
  });

  it('bare non-TTY invocation prints help to stderr with exit 1', () => {
    expect(resolveEntryMode([], false)).toBe('help');
  });

  // Regression: flags used to be treated as "no subcommand", so `ccps --help`
  // and `ccps --version` on a dual-TTY terminal opened the Workbench instead
  // of printing help/version.
  it.each(['--help', '--version', '-h', '-V'])(
    'global flag %s goes to Commander even on a dual-TTY terminal',
    (flag) => {
      expect(resolveEntryMode([flag], true)).toBe('commander');
    },
  );

  it('subcommands go to Commander on any terminal', () => {
    expect(resolveEntryMode(['tui'], true)).toBe('commander');
    expect(resolveEntryMode(['launch', 'coding'], false)).toBe('commander');
  });

  it('a leading flag still goes to Commander', () => {
    expect(resolveEntryMode(['--help', 'launch'], true)).toBe('commander');
  });
});
