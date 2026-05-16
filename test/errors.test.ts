import { describe, expect, it } from 'vitest';

import { CcpsError, formatError } from '../src/utils/errors';

describe('structured errors', () => {
  it('keeps a stable code and user-facing guidance', () => {
    const error = new CcpsError('INVALID_PROFILE_NAME', 'Profile name is not safe.', {
      guidance: 'Use letters, numbers, hyphen, or underscore.',
    });

    expect(error.code).toBe('INVALID_PROFILE_NAME');
    expect(error.guidance).toBe('Use letters, numbers, hyphen, or underscore.');
    expect(formatError(error)).toBe(
      'INVALID_PROFILE_NAME: Profile name is not safe.\nNext: Use letters, numbers, hyphen, or underscore.',
    );
  });

  it('formats unknown errors without losing the message', () => {
    expect(formatError(new Error('boom'))).toBe('boom');
    expect(formatError('plain failure')).toBe('plain failure');
  });
});
