import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('README', () => {
  it('documents the MVP workflow, launch behavior, and safety boundaries', async () => {
    const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8');

    expect(readme).toContain('ccps launch <profile> --dry-run');
    expect(readme).toContain('CLAUDE_CONFIG_DIR');
    expect(readme).toContain('Current working directory');
    expect(readme).toContain('OAuth');
    expect(readme).toContain('session');
    expect(readme).toContain('token');
    expect(readme).toContain('npm run check');
  });
});
