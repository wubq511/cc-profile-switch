import { describe, expect, it, vi } from 'vitest';

import { createTerminalTuiPorts, runTerminalTui } from '../src/tui/terminal';

describe('tui terminal adapter', () => {
  it('select renders numbered choices and returns the selected value', async () => {
    const output: string[] = [];
    const ask = vi.fn(async () => '2');
    const ports = createTerminalTuiPorts({
      writeOut: (value) => output.push(value),
      ask,
    });

    const result = await ports.select('Choose an action', [
      { value: 'list', label: 'List profiles' },
      { value: 'exit', label: 'Exit' },
    ]);

    expect(result).toBe('exit');
    expect(output.join('')).toContain('Choose an action');
    expect(output.join('')).toContain('1. List profiles');
    expect(output.join('')).toContain('2. Exit');
    expect(ask).toHaveBeenCalledWith('Select number: ');
  });

  it('select repeats on invalid input and keeps state unchanged until a valid choice is selected', async () => {
    const output: string[] = [];
    const responses = ['abc', '9', '1'];
    const ports = createTerminalTuiPorts({
      writeOut: (value) => output.push(value),
      ask: async () => responses.shift() ?? '1',
    });

    const result = await ports.select('Choose', [
      { value: 'list', label: 'List profiles' },
      { value: 'exit', label: 'Exit' },
    ]);

    expect(result).toBe('list');
    expect(output.join('')).toContain('Choose a number from 1 to 2.');
  });

  it('input and confirmByName delegate to the readline question boundary', async () => {
    const asked: string[] = [];
    const ports = createTerminalTuiPorts({
      writeOut: () => undefined,
      ask: async (prompt) => {
        asked.push(prompt);
        return prompt.includes('remove') ? 'coding' : 'focus';
      },
    });

    await expect(ports.input('Profile: ')).resolves.toBe('focus');
    await expect(ports.confirmByName('coding', 'Type the exact profile name to remove "coding": ')).resolves.toBe(
      'coding',
    );
    expect(asked).toEqual(['Profile: ', 'Type the exact profile name to remove "coding": ']);
  });

  it('runTerminalTui creates terminal ports and delegates to the controller', async () => {
    const output: string[] = [];
    const runController = vi.fn(async () => undefined);

    await runTerminalTui({
      appHomePath: 'C:\\app',
      writeOut: (value) => output.push(value),
      runController,
      ask: async () => '1',
    });

    expect(runController).toHaveBeenCalledWith(
      expect.objectContaining({
        appHomePath: 'C:\\app',
        ports: expect.objectContaining({
          writeOut: expect.any(Function),
          select: expect.any(Function),
          input: expect.any(Function),
          confirmByName: expect.any(Function),
        }),
      }),
    );
  });
});
