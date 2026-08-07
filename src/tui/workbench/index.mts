// Profile Workbench ESM entry — issue #54
// Loaded via dynamic import() from the CJS bin when stdin.isTTY && stdout.isTTY.
// Manages alternate screen, signal handlers, the Ink render loop (spec §10:
// a launch unmounts Ink, spawns Claude synchronously, then re-renders the
// Workbench in place), and cleanup.

import React from 'react';
import { render } from 'ink';

import { loadWorkbenchData } from './profile-data';
import { WorkbenchApp, takeLaunchResumeState, type LaunchResumeState } from './app';
import { createLaunchHandler } from './launch-cycle';
import { resolveLocale, type Locale } from './i18n/react';
import {
  getAppHomePaths,
  loadAppConfigSync,
  saveWorkbenchLanguageSync,
} from '../../core/app-config';
import { loadAppStateSync, recordHintUseSync } from '../../core/app-state';
import { getLastSweepResult, runStartupSweep } from '../../core/recovery-bin';
import { CcpsError } from '../../utils/errors';

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const CURSOR_SHOW = '\x1b[?25h';
const FOCUS_ON = '\x1b[?1004h';
const FOCUS_OFF = '\x1b[?1004l';

const out = process.stdout;

function writeCleanup(): void {
  out.write(FOCUS_OFF + CURSOR_SHOW + ALT_OFF);
}

let halted = false;
function halt(): void {
  if (halted) return;
  halted = true;
  writeCleanup();
  process.exit(0);
}

process.on('SIGINT', halt);
process.on('SIGTERM', halt);

async function main(): Promise<void> {
  let data = await loadWorkbenchData();
  const appHomePath = getAppHomePaths().appHomePath;

  // Spec §9.4 lazy startup sweep for the bare-`ccps` Workbench entry (which
  // bypasses commander). CLI commands — including `ccps tui` — sweep in the
  // commander preAction hook; the in-memory result guard makes this a no-op
  // when the hook already ran in this process. Failure-isolated inside
  // runStartupSweep; the one-line summary prints before the alternate screen.
  if (getLastSweepResult() === null) {
    const report = await runStartupSweep(appHomePath);
    if (report.pendingSummary !== null) {
      out.write(`${report.pendingSummary}\n`);
    }
  }

  // Locale resolution chain (issue #54, spec §14.10): explicit
  // `workbench.language` in config.json → system locale. A missing config
  // falls through to the system locale; corruption stays loud (§13.4 rule 4).
  // `workbench.editor` (§13.2) rides the same read: the external-edit handoff
  // uses it as the editor command override.
  let configLanguage: 'zh' | 'en' | undefined;
  let configEditor: string | undefined;
  try {
    const config = loadAppConfigSync(appHomePath);
    configLanguage = config.workbench.language;
    configEditor = config.workbench.editor;
  } catch (error) {
    if (!(error instanceof CcpsError && error.code === 'APP_CONFIG_NOT_FOUND')) throw error;
  }
  let currentLocale: Locale = resolveLocale(configLanguage);
  let resumeState: LaunchResumeState | null = null;

  function onLocaleChange(locale: Locale): void {
    currentLocale = locale;
    // Write the switch back to config.json so the next session resolves it
    // from the chain's first step. Best-effort inside the TUI: a missing
    // config (ccps init never ran) or an I/O failure leaves the switch
    // session-scoped instead of crashing the Workbench.
    try {
      saveWorkbenchLanguageSync(appHomePath, locale);
    } catch {
      // non-fatal — see above
    }
  }

  function onHintUsed(key: string): void {
    // Persist each hint-key use so retirement is permanent across sessions
    // (issue #76). Best-effort: the session-local count advances regardless.
    try {
      recordHintUseSync(appHomePath, key);
    } catch {
      // non-fatal — see above
    }
  }

  // Render loop (spec §10): a launch request unmounts the Ink instance and
  // hands the terminal to Claude; when Claude exits, the loop reloads the
  // data and re-renders the Workbench in place with the pre-launch selection
  // restored and the exit flash showing. Ink render() instances are
  // single-use after unmount, hence a fresh render per cycle.
  for (;;) {
    out.write(ALT_ON + FOCUS_ON);

    // Re-read persisted hint counts each cycle (issue #76): uses from the
    // pre-launch mount were written to state.json, so the remounted provider
    // seeds from disk instead of losing them.
    let initialHintUsage: Record<string, number> = {};
    try {
      initialHintUsage = loadAppStateSync(appHomePath).hintUsage ?? {};
    } catch (error) {
      if (!(error instanceof CcpsError && error.code === 'APP_STATE_NOT_FOUND')) throw error;
    }

    let launchRequested = false;
    const instance = render(
      React.createElement(WorkbenchApp, {
        data,
        initialLocale: currentLocale,
        onLocaleChange,
        resumeState,
        initialHintUsage,
        onHintUsed,
        editorOverride: configEditor,
        onLaunch(plan, appHomePath): number | null {
          launchRequested = true;
          return launchHandler(plan, appHomePath);
        },
      }),
      { exitOnCtrlC: false, interactive: true },
    );
    // Declared after render() but only invoked from keyboard input, by which
    // point the binding is initialized (onLaunch never fires during mount).
    const launchHandler = createLaunchHandler({
      unmount: () => instance.unmount(),
      leaveAlternateScreen: writeCleanup,
    });
    // Consumed by this mount; only set again by a completed launch cycle.
    resumeState = null;

    await instance.waitUntilExit();

    if (!launchRequested) break;

    // Claude ran and exited. Reload so external changes (Profile edits made
    // from the Claude session, recents, metadata) show in the resumed UI,
    // and pick up the selection/exit-code published by performLaunch.
    data = await loadWorkbenchData();
    resumeState = takeLaunchResumeState();
  }

  writeCleanup();
  process.exit(0);
}

main().catch((error: unknown) => {
  writeCleanup();
  if (error instanceof Error) {
    process.stderr.write(`WORKBENCH_ERROR: ${error.message}\n`);
  } else {
    process.stderr.write(`WORKBENCH_ERROR: ${String(error)}\n`);
  }
  process.exit(1);
});
