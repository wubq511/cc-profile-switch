import { describe, expect, it } from 'vitest';

import {
  getPathPlatform,
  getAppHomePath,
  isPathInside,
  resolveInside,
  resolveUserHome,
  validateProfileName,
} from '../src/platform/path';
import { CcpsError } from '../src/utils/errors';

describe('platform path helpers', () => {
  it('resolves the Windows user home from USERPROFILE', () => {
    expect(resolveUserHome({ USERPROFILE: 'C:\\Users\\Robert' }, 'win32')).toBe(
      'C:\\Users\\Robert',
    );
  });

  it('resolves the macOS user home from HOME', () => {
    expect(resolveUserHome({ HOME: '/Users/robert' }, 'darwin')).toBe('/Users/robert');
  });

  it('resolves the Linux user home from HOME', () => {
    expect(resolveUserHome({ HOME: '/home/robert' }, 'linux')).toBe('/home/robert');
  });

  it('rejects unsupported runtime platforms', () => {
    expect(() => resolveUserHome({ HOME: '/home/robert' }, 'freebsd')).toThrow(
      expect.objectContaining({
        code: 'PLATFORM_NOT_SUPPORTED',
      }),
    );
  });

  it('resolves the app home under the user home', () => {
    expect(getAppHomePath('C:\\Users\\Robert')).toBe('C:\\Users\\Robert\\.cc-profile-switch');
    expect(getAppHomePath('/Users/robert')).toBe('/Users/robert/.cc-profile-switch');
  });

  it('keeps POSIX absolute test paths usable on non-Windows hosts', () => {
    if (process.platform === 'win32') {
      return;
    }

    expect(getAppHomePath('/var/folders/example/user')).toBe(
      '/var/folders/example/user/.cc-profile-switch',
    );
    expect(
      resolveInside('/var/folders/example/user/.cc-profile-switch', 'profiles', 'coding'),
    ).toBe('/var/folders/example/user/.cc-profile-switch/profiles/coding');
  });

  it('detects contained Windows paths case-insensitively', () => {
    expect(
      isPathInside(
        'C:\\Users\\Robert\\.cc-profile-switch',
        'c:\\users\\robert\\.cc-profile-switch\\profiles',
      ),
    ).toBe(true);
  });

  it('detects contained POSIX paths case-sensitively', () => {
    expect(
      isPathInside('/Users/robert/.cc-profile-switch', '/Users/robert/.cc-profile-switch/profiles'),
    ).toBe(true);
    expect(
      isPathInside('/Users/robert/.cc-profile-switch', '/Users/Robert/.cc-profile-switch/profiles'),
    ).toBe(false);
  });

  it('rejects sibling paths that only share a prefix', () => {
    expect(
      isPathInside(
        'C:\\Users\\Robert\\.cc-profile-switch',
        'C:\\Users\\Robert\\.cc-profile-switch-bak',
      ),
    ).toBe(false);
  });

  it('blocks traversal when resolving child paths', () => {
    expect(() =>
      resolveInside('C:\\Users\\Robert\\.cc-profile-switch', 'profiles', '..', '..', '.claude'),
    ).toThrow(
      expect.objectContaining({
        code: 'PATH_OUTSIDE_BASE',
      }),
    );
  });

  it('blocks traversal with Windows separators under a POSIX app home', () => {
    expect(() =>
      resolveInside('/Users/robert/.cc-profile-switch', 'profiles', '..\\..\\.claude'),
    ).toThrow(
      expect.objectContaining({
        code: 'PATH_OUTSIDE_BASE',
      }),
    );
  });

  it('classifies path APIs from explicit path shapes instead of the current host only', () => {
    expect(getPathPlatform('C:\\Users\\Robert\\.cc-profile-switch')).toBe('win32');
    expect(getPathPlatform('/Users/robert/.cc-profile-switch')).toBe('posix');
  });

  it('validates safe profile names', () => {
    expect(validateProfileName('coding')).toBe('coding');
    expect(validateProfileName('study_2026')).toBe('study_2026');
  });

  it.each([
    '',
    '.',
    '..',
    'general/settings',
    'general\\settings',
    'with space',
    'CON',
    'profiles',
  ])('rejects unsafe profile name %j', (name) => {
    expect(() => validateProfileName(name)).toThrow(CcpsError);
  });
});
