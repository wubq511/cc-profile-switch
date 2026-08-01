import { describe, expect, it } from 'vitest';

import { getPlatformLinkKind } from '../src/platform/link';

// Cross-platform link-kind selection (AGENTS.md Platform Contract: behavior that
// differs by platform needs explicit win32/darwin/linux tests). The physical
// primitive is a junction on Windows (absolute, no privilege) and a symlink
// elsewhere — proven by issues #49/#50 and the `probe:linked-skill` harness.

describe('getPlatformLinkKind', () => {
  it('selects a junction on Windows', () => {
    expect(getPlatformLinkKind('win32')).toBe('junction');
  });

  it('selects a symlink on macOS', () => {
    expect(getPlatformLinkKind('darwin')).toBe('symlink');
  });

  it('selects a symlink on Linux', () => {
    expect(getPlatformLinkKind('linux')).toBe('symlink');
  });

  it('defaults to the current process platform', () => {
    const expected = process.platform === 'win32' ? 'junction' : 'symlink';
    expect(getPlatformLinkKind()).toBe(expected);
  });
});
