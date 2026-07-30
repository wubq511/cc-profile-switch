import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('cross-platform CI workflow', () => {
  it('runs the full check on every supported OS and Node.js LTS line', async () => {
    const workflow = await readFile(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8');

    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('push:\n    branches: [main]');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
    expect(workflow).toContain('node: [22, 24]');
    expect(workflow).toContain('fail-fast: false');
    expect(workflow).toContain('uses: actions/checkout@v6');
    expect(workflow).toContain('uses: actions/setup-node@v6');
    expect(workflow).toContain('run: npm ci');
    expect(workflow).toContain('run: npm run check');
  });

  it('keeps the package runtime floor aligned with the tested LTS lines', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      engines?: { node?: string };
      keywords?: string[];
    };
    const tsupConfig = await readFile(join(process.cwd(), 'tsup.config.ts'), 'utf8');

    expect(packageJson.engines?.node).toBe('>=22');
    expect(packageJson.keywords).toContain('linux');
    expect(tsupConfig).toContain("target: 'node22'");
  });
});
