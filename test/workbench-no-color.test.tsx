// Issue #100 / #90 user story 27 (spec §14): NO_COLOR must suppress all ANSI
// styling in the Workbench's Ink/chalk pipeline, matching the picocolors
// behavior the CLI path already has.

import React from 'react';
import { render, Text } from 'ink';
import chalk from 'chalk';
import { afterEach, describe, expect, it } from 'vitest';

import { FakeTtyStdout } from './render-helpers';
import { applyNoColorPreference } from '../src/tui/workbench/no-color';

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[0-9;]*m/;

async function renderFrame(element: React.ReactElement): Promise<string> {
  const stdout = new FakeTtyStdout();
  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
  });
  await instance.waitUntilRenderFlush();
  const out = stdout.output;
  instance.unmount();
  return out;
}

describe('applyNoColorPreference (issue #100)', () => {
  const originalLevel = chalk.level;

  afterEach(() => {
    chalk.level = originalLevel;
    delete process.env.NO_COLOR;
  });

  it('strips every SGR sequence from Ink output when NO_COLOR is set', async () => {
    process.env.NO_COLOR = '1';
    applyNoColorPreference();
    const out = await renderFrame(
      <Text color="green" backgroundColor="blue" bold>
        hello
      </Text>,
    );
    expect(out).toContain('hello');
    expect(out).not.toMatch(SGR);
  });

  it('matches picocolors semantics: an empty NO_COLOR does not disable color', () => {
    chalk.level = 2;
    process.env.NO_COLOR = '';
    applyNoColorPreference();
    expect(chalk.level).toBe(2);
  });

  it('leaves color enabled when NO_COLOR is absent', async () => {
    delete process.env.NO_COLOR;
    chalk.level = 2;
    applyNoColorPreference();
    expect(chalk.level).toBe(2);
    const out = await renderFrame(<Text color="green">hello</Text>);
    expect(out).toMatch(SGR);
  });
});
