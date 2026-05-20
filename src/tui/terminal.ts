import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { createInterface, type Interface } from 'node:readline/promises';

import { type Clock } from '../core/app-config';
import {
  runTuiController,
  type RunTuiControllerOptions,
  type TuiChoice,
  type TuiControllerServices,
  type TuiPorts,
} from './controller';

export type TerminalQuestion = (prompt: string) => Promise<string>;

export type CreateTerminalTuiPortsOptions = {
  writeOut: (value: string) => void;
  ask: TerminalQuestion;
};

export type RunTerminalTuiOptions = {
  appHomePath?: string;
  writeOut?: (value: string) => void;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  ask?: TerminalQuestion;
  services?: Partial<TuiControllerServices>;
  clock?: Clock;
  runController?: (options: RunTuiControllerOptions) => Promise<void>;
};

export function createTerminalTuiPorts(options: CreateTerminalTuiPortsOptions): TuiPorts {
  return {
    writeOut: options.writeOut,
    select: async (prompt, choices) => selectChoice(prompt, choices, options),
    input: async (prompt) => options.ask(prompt),
    confirmByName: async (_name, prompt) => options.ask(prompt),
  };
}

export async function runTerminalTui(options: RunTerminalTuiOptions = {}): Promise<void> {
  const writeOut = options.writeOut ?? ((value: string) => process.stdout.write(value));
  let readline: Interface | undefined;
  const ask =
    options.ask ??
    (async (prompt: string) => {
      readline ??= createInterface({
        input: options.input ?? defaultInput,
        output: options.output ?? defaultOutput,
      });

      return readline.question(prompt);
    });
  const ports = createTerminalTuiPorts({ writeOut, ask });
  const runController = options.runController ?? runTuiController;

  try {
    await runController({
      appHomePath: options.appHomePath,
      ports,
      services: options.services,
      clock: options.clock,
    });
  } finally {
    readline?.close();
  }
}

async function selectChoice(
  prompt: string,
  choices: TuiChoice[],
  options: CreateTerminalTuiPortsOptions,
): Promise<string> {
  while (true) {
    options.writeOut(`${prompt}\n`);
    choices.forEach((choice, index) => {
      options.writeOut(`${index + 1}. ${choice.label}\n`);
    });

    const answer = await options.ask('Select number: ');
    const selectedIndex = Number.parseInt(answer.trim(), 10) - 1;
    if (selectedIndex >= 0 && selectedIndex < choices.length) {
      return choices[selectedIndex].value;
    }

    options.writeOut(`Choose a number from 1 to ${choices.length}.\n`);
  }
}
