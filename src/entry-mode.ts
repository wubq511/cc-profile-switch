/** Entry routing for the ccps bin (issue #54 §3.1).
 *
 * Only a truly bare invocation — zero arguments — shortcuts to the Workbench
 * (dual-TTY) or to stderr help with exit 1 (non-TTY). Any argument at all,
 * including global flags like --help/--version, goes through Commander, so
 * `ccps --help` in a terminal prints help instead of opening the Workbench. */
export type EntryMode = 'workbench' | 'help' | 'commander';

export function resolveEntryMode(args: string[], isDualTty: boolean): EntryMode {
  if (args.length === 0) {
    return isDualTty ? 'workbench' : 'help';
  }
  return 'commander';
}
