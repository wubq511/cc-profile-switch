import { describe, expect, it } from 'vitest';

import {
  getAppHomePath,
  isPathInside,
  resolveInside,
  resolveUserHome,
  validateProfileName,
} from '../src/platform/windows-path';
import { CcpsError } from '../src/utils/errors';

describe('windows path helpers', () => {
  it('resolves the Windows user home from USERPROFILE', () => {
    expect(resolveUserHome({ USERPROFILE: 'C:\\Users\\Robert' })).toBe('C:\\Users\\Robert');
  });

  it('resolves the app home under the user home', () => {
    expect(getAppHomePath('C:\\Users\\Robert')).toBe('C:\\Users\\Robert\\.cc-profile-switch');
  });

  it('detects contained paths case-insensitively', () => {
    expect(isPathInside('C:\\Users\\Robert\\.cc-profile-switch', 'c:\\users\\robert\\.cc-profile-switch\\profiles')).toBe(
      true,
    );
  });

  it('rejects sibling paths that only share a prefix', () => {
    expect(isPathInside('C:\\Users\\Robert\\.cc-profile-switch', 'C:\\Users\\Robert\\.cc-profile-switch-bak')).toBe(
      false,
    );
  });

  it('blocks traversal when resolving child paths', () => {
    expect(() => resolveInside('C:\\Users\\Robert\\.cc-profile-switch', 'profiles', '..', '..', '.claude')).toThrow(
      expect.objectContaining({
        code: 'PATH_OUTSIDE_BASE',
      }),
    );
  });

  it('validates safe profile names', () => {
    expect(validateProfileName('coding')).toBe('coding');
    expect(validateProfileName('study_2026')).toBe('study_2026');
  });

  it.each(['', '.', '..', 'general/settings', 'general\\settings', 'with space', 'CON', 'profiles'])(
    'rejects unsafe profile name %j',
    (name) => {
      expect(() => validateProfileName(name)).toThrow(CcpsError);
    },
  );
});
