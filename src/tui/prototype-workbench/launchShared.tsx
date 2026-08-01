// PROTOTYPE (throwaway) — shared chrome and mock launch data for issue #32
// (launch + project-directory flow variants J/K). The navigation model is
// locked per #25 and deliberately identical here; only the launch flow
// differs between variants.

import React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { Profile } from './data';
import { windowed } from './shell';

export interface MockFinding {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}
export interface MockValidation {
  status: 'valid' | 'warning' | 'error';
  findings: MockFinding[];
}

// Mirrors src/core/validator.ts finding codes: any error finding blocks launch.
export function validationFor(p: Profile): MockValidation {
  switch (p.name) {
    case 'experiments':
    case 'scratch':
      return {
        status: 'error',
        findings: [
          { severity: 'error', code: 'REQUIRED_FILE_MISSING', message: 'settings.json missing (claude-home/settings.json)' },
          { severity: 'error', code: 'PROFILE_MANIFEST_INVALID', message: 'profile.json failed to parse' },
        ],
      };
    case 'writing':
    case 'archived-2025':
      return {
        status: 'warning',
        findings: [
          { severity: 'warning', code: 'CCPS_PROFILE_RULE_MISSING', message: 'managed rule absent (backfilled on launch)' },
        ],
      };
    default:
      return { status: 'valid', findings: [] };
  }
}

export const START_CWD = process.cwd();
export const RECENT_DIRS = ['~/work/api-server', '~/work/web-storefront', '~/playground/sandbox'];
export const claudeHome = (name: string) => `~/.cc-profile-switch/profiles/${name}/claude-home`;

// Abbreviated from formatLaunchDryRun in src/core/launcher.ts.
export function dryRunLines(profileName: string, cwd: string, v: MockValidation): string[] {
  return [
    `Launch dry-run for profile "${profileName}"`,
    `Profile path: ~/.cc-profile-switch/profiles/${profileName}`,
    `Claude home: ${claudeHome(profileName)}`,
    `Cwd: ${cwd}`,
    `MCP mode: native user scope (${claudeHome(profileName)}/.claude.json)`,
    'Command: claude',
    'Args: (none)',
    'Env changes:',
    `  CLAUDE_CONFIG_DIR=${claudeHome(profileName)}`,
    `Validation: ${v.status}`,
    ...(v.findings.length
      ? ['Findings:', ...v.findings.map((f) => `  [${f.severity}] ${f.code}: ${f.message}`)]
      : []),
    'Project config: preserved because Claude starts in the launch cwd.',
    'Dry run: Claude Code was not started.',
  ];
}

export function statusMark(status: MockValidation['status']): { mark: string; color: string } {
  if (status === 'valid') return { mark: '✓', color: 'green' };
  if (status === 'warning') return { mark: '⚠', color: 'yellow' };
  return { mark: '✕', color: 'red' };
}

// Minimal locked-model chrome: sidebar Profile list with validation marks,
// main pane supplied by the variant. Arrows move when navActive.
export function WorkbenchFrame(props: {
  profiles: Profile[];
  pi: number;
  setPi: (n: number) => void;
  navActive: boolean;
  footer: string;
  children: React.ReactNode;
}) {
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;
  const sideW = Math.max(28, Math.min(38, Math.floor(cols * 0.32)));
  const listH = Math.max(3, rows - 7);
  const { slice, start } = windowed(props.profiles, props.pi, listH);

  useInput((_input, key) => {
    if (!props.navActive || props.profiles.length === 0) return;
    if (key.upArrow) props.setPi(Math.max(0, props.pi - 1));
    else if (key.downArrow) props.setPi(Math.min(props.profiles.length - 1, props.pi + 1));
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexGrow={1} paddingX={1} gap={1}>
        <Box flexDirection="column" width={sideW} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text dimColor>▸ [/] search (unchanged per #25)</Text>
          <Text dimColor>{'─'.repeat(Math.max(4, sideW - 6))}</Text>
          <Text bold color="cyan">
            Profiles ({props.profiles.length})
          </Text>
          {slice.map((p, i) => {
            const v = validationFor(p);
            const { mark, color } = statusMark(v.status);
            const isSel = start + i === props.pi;
            return (
              <Text key={p.name} inverse={isSel} wrap="truncate">
                <Text color={color}>{mark}</Text> {p.name}
                {p.isDefault ? ' ★' : ''}
              </Text>
            );
          })}
          {!props.profiles.length && <Text dimColor>No Profiles yet.</Text>}
          <Box flexGrow={1} />
          <Text dimColor>launch flow prototype · #32</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="gray" paddingX={1}>
          {props.children}
        </Box>
      </Box>
      <Text color="cyan"> {props.footer}</Text>
    </Box>
  );
}
