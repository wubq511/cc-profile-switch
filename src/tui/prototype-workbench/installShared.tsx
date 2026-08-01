// PROTOTYPE (throwaway) — shared data & logic for the local Skill install
// variants (issue #30). Question: what interaction makes Copy and Link equally
// visible with Copy the default, explains ownership & update semantics,
// previews target changes, checks link health, handles name collisions, and
// fails safely when the platform cannot create a link?
// Layout stays per-variant on purpose; only the mock scenario is shared.
// Domain language follows CONTEXT.md; provenance per issue #38; removals land
// in the Recovery Bin per issue #33.

import React from 'react';
import { Text } from 'ink';
import type { SkillEntry } from './data';

export type InstallMode = 'copy' | 'link';

export interface LocalSkillSource {
  path: string; // display path of the Local Skill Source
  name: string; // install directory name derived from the source
  valid: boolean; // SKILL.md present (false exercises the health check)
}

// Mock Local Skill Sources the user can pick from.
//  - commit-helper: clean install
//  - tdd / grilling: collide with existing Skills in "coding"
//  - scratch-skill: no SKILL.md — health check must fail safe
export const LOCAL_SOURCES: LocalSkillSource[] = [
  { path: '~/oss/my-skills/commit-helper', name: 'commit-helper', valid: true },
  { path: '~/oss/my-skills/tdd', name: 'tdd', valid: true },
  { path: '~/oss/my-skills/grilling', name: 'grilling', valid: true },
  { path: '~/tmp/scratch-skill', name: 'scratch-skill', valid: false },
];

// The Skills already installed in the demo Profile "coding" (from data.ts).
export const EXISTING_SKILLS: SkillEntry[] = [
  { name: 'wayfinder', kind: 'copied' },
  { name: 'grilling', kind: 'copied' },
  { name: 'tdd', kind: 'copied' },
  { name: 'diagnosing-bugs', kind: 'linked', source: '~/oss/my-skills/diagnosing-bugs' },
  { name: 'code-review', kind: 'copied' },
];

export const TARGET_DIR = '~/.cc-profile-switch/profiles/coding/claude-home/skills';

export function collides(name: string): SkillEntry | undefined {
  return EXISTING_SKILLS.find((s) => s.name === name);
}

export function suggestName(name: string): string {
  let n = 2;
  while (collides(`${name}-${n}`)) n++;
  return `${name}-${n}`;
}

export interface Check {
  ok: boolean;
  text: string;
}

// Health / feasibility checks for installing `src` under `mode`.
// `denied` simulates a platform that cannot create links (e.g. Windows
// without Developer Mode / symlink privilege).
export function checksFor(src: LocalSkillSource, mode: InstallMode, denied: boolean): Check[] {
  const out: Check[] = [
    src.valid
      ? { ok: true, text: 'source readable · SKILL.md found' }
      : { ok: false, text: 'no SKILL.md in source — not a Skill' },
  ];
  if (mode === 'link') {
    out.push(
      denied
        ? { ok: false, text: 'platform cannot create links (Windows: enable Developer Mode)' }
        : { ok: true, text: 'platform can create links' },
    );
  }
  return out;
}

export function canInstall(src: LocalSkillSource, mode: InstallMode, denied: boolean, name: string): boolean {
  return checksFor(src, mode, denied).every((c) => c.ok) && !collides(name);
}

// Target-change preview lines (what installing would write), per mode.
export function previewLines(src: LocalSkillSource, mode: InstallMode, name: string): string[] {
  return mode === 'copy'
    ? [
        `create  ${TARGET_DIR}/${name}/   (snapshot — Profile-owned)`,
        `record  skills-provenance.json  ← copy · source ${src.path} · sha256 fingerprint`,
      ]
    : [
        `link    ${TARGET_DIR}/${name}  →  ${src.path}`,
        `record  skills-provenance.json  ← link · live source · health checked`,
      ];
}

export function Breadcrumb({ extra }: { extra?: string }) {
  return (
    <Text bold>
      coding › Skills › add local skill{extra ? <Text dimColor>  ·  {extra}</Text> : null}
    </Text>
  );
}
