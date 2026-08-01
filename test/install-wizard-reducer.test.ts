import { describe, expect, it } from 'vitest';

import {
  initialInstallWizardState,
  installWizardReducer,
} from '../src/tui/workbench/skills/install-wizard-reducer';
import type { InstallPreview, LocalSkillSourceInfo } from '../src/core/skills-install';

function start(): ReturnType<typeof initialInstallWizardState> {
  return installWizardReducer(initialInstallWizardState(), { type: 'START', profileName: 'coding' });
}

function typeSource(state: ReturnType<typeof initialInstallWizardState>, text: string) {
  let s = state;
  for (const ch of text) s = installWizardReducer(s, { type: 'SOURCE_CHAR', char: ch });
  return s;
}

function typeCollision(state: ReturnType<typeof initialInstallWizardState>, text: string) {
  // Replace the prefilled suggestion by backspacing it out first.
  let s = state;
  const prefilled = s.collisionInput;
  for (let i = 0; i < prefilled.length; i++) {
    s = installWizardReducer(s, { type: 'COLLISION_BACKSPACE' });
  }
  for (const ch of text) s = installWizardReducer(s, { type: 'COLLISION_CHAR', char: ch });
  return s;
}

const validSourceInfo: LocalSkillSourceInfo = {
  sourcePath: '/oss/my-skills/commit-helper',
  readable: true,
  skillMdPresent: true,
  suggestedName: 'commit-helper',
};

function preview(overrides: Partial<InstallPreview> = {}): InstallPreview {
  return {
    mode: 'copy',
    name: 'commit-helper',
    targetPath: '/profiles/coding/claude-home/skills/commit-helper',
    sourcePath: '/oss/my-skills/commit-helper',
    checks: [
      { code: 'source-readable', ok: true, message: 'source readable' },
      { code: 'skill-md-present', ok: true, message: 'SKILL.md present' },
    ],
    previewLines: ['create  /target/   (snapshot)', 'record  skills-provenance.json'],
    canInstall: true,
    collides: false,
    existingIsLink: false,
    existingNames: [],
    ...overrides,
  };
}

describe('install wizard reducer', () => {
  it('starts closed and opens on START with Copy pre-selected', () => {
    expect(initialInstallWizardState().open).toBe(false);
    const s = start();
    expect(s.open).toBe(true);
    expect(s.phase).toBe('source');
    expect(s.profileName).toBe('coding');
    expect(s.mode).toBe('copy'); // Copy is the default per spec §7.2
  });

  it('accumulates source input and submits to validating', () => {
    let s = start();
    s = typeSource(s, '/path');
    expect(s.sourceInput).toBe('/path');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    expect(s.phase).toBe('validating');
  });

  it('ignores SOURCE_SUBMIT on empty input', () => {
    let s = start();
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    expect(s.phase).toBe('source');
  });

  it('resolves a valid source to the mode step with suggested name', () => {
    let s = start();
    s = typeSource(s, '/oss/commit-helper');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    s = installWizardReducer(s, { type: 'SOURCE_RESOLVED', info: validSourceInfo });
    expect(s.phase).toBe('mode');
    expect(s.sourceInfo).toBe(validSourceInfo);
    expect(s.name).toBe('commit-helper');
  });

  it('reports an invalid source back to the source step', () => {
    let s = start();
    s = typeSource(s, '/bad');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    s = installWizardReducer(s, { type: 'SOURCE_INVALID', message: 'no SKILL.md' });
    expect(s.phase).toBe('source');
    expect(s.sourceError).toBe('no SKILL.md');
  });

  it('selects Copy and Link and confirms to confirming', () => {
    let s = start();
    s = typeSource(s, '/x');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    s = installWizardReducer(s, { type: 'SOURCE_RESOLVED', info: validSourceInfo });

    s = installWizardReducer(s, { type: 'SELECT_MODE', mode: 'link' });
    expect(s.mode).toBe('link');
    s = installWizardReducer(s, { type: 'SELECT_MODE', mode: 'copy' });
    expect(s.mode).toBe('copy');

    s = installWizardReducer(s, { type: 'MODE_CONFIRM' });
    expect(s.phase).toBe('confirming');
  });

  it('delivers the preview to the confirm step', () => {
    let s = start();
    s = typeSource(s, '/x');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    s = installWizardReducer(s, { type: 'SOURCE_RESOLVED', info: validSourceInfo });
    s = installWizardReducer(s, { type: 'MODE_CONFIRM' });
    s = installWizardReducer(s, { type: 'PREVIEW_READY', preview: preview() });
    expect(s.phase).toBe('confirm');
    expect(s.preview?.name).toBe('commit-helper');
  });

  it('confirm → installing when there is no collision', () => {
    let s = start();
    s = typeSource(s, '/x');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    s = installWizardReducer(s, { type: 'SOURCE_RESOLVED', info: validSourceInfo });
    s = installWizardReducer(s, { type: 'MODE_CONFIRM' });
    s = installWizardReducer(s, { type: 'PREVIEW_READY', preview: preview() });
    s = installWizardReducer(s, { type: 'CONFIRM_INSTALL' });
    expect(s.phase).toBe('installing');
    expect(s.collisionResolution).toBeNull();
  });

  it('confirm refuses to install when pre-install health checks fail (canInstall false)', () => {
    // Link-incapable platform or a self-referential target leaves canInstall false;
    // Enter must not dispatch installing (which would throw in the core service).
    const p = preview({
      canInstall: false,
      checks: [
        { code: 'source-readable', ok: true, message: 'source readable' },
        { code: 'skill-md-present', ok: true, message: 'SKILL.md present' },
        { code: 'platform-can-link', ok: false, message: 'platform cannot create links' },
      ],
    });
    let s = start();
    s = typeSource(s, '/x');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    s = installWizardReducer(s, { type: 'SOURCE_RESOLVED', info: validSourceInfo });
    s = installWizardReducer(s, { type: 'MODE_CONFIRM' });
    s = installWizardReducer(s, { type: 'PREVIEW_READY', preview: p });
    s = installWizardReducer(s, { type: 'CONFIRM_INSTALL' });
    expect(s.phase).toBe('confirm'); // stays put — health blocker gates the install
  });

  it('confirm → collision when the name collides, with a suggested rename prefilled', () => {
    const p = preview({ collides: true, existingNames: ['commit-helper'] });
    let s = start();
    s = typeSource(s, '/x');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    s = installWizardReducer(s, { type: 'SOURCE_RESOLVED', info: validSourceInfo });
    s = installWizardReducer(s, { type: 'MODE_CONFIRM' });
    s = installWizardReducer(s, { type: 'PREVIEW_READY', preview: p });
    s = installWizardReducer(s, { type: 'CONFIRM_INSTALL' });
    expect(s.phase).toBe('collision');
    expect(s.collisionInput).toBe('commit-helper-2');
  });

  it('collision → replace installs with collisionResolution=replace', () => {
    const p = preview({ collides: true, existingNames: ['commit-helper'] });
    let s = start();
    s = typeSource(s, '/x');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    s = installWizardReducer(s, { type: 'SOURCE_RESOLVED', info: validSourceInfo });
    s = installWizardReducer(s, { type: 'MODE_CONFIRM' });
    s = installWizardReducer(s, { type: 'PREVIEW_READY', preview: p });
    s = installWizardReducer(s, { type: 'CONFIRM_INSTALL' });
    s = installWizardReducer(s, { type: 'COLLISION_REPLACE' });
    expect(s.phase).toBe('installing');
    expect(s.collisionResolution).toBe('replace');
  });

  it('collision → rename applies the typed name and re-previews', () => {
    const p = preview({ collides: true, existingNames: ['commit-helper'] });
    let s = start();
    s = typeSource(s, '/x');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    s = installWizardReducer(s, { type: 'SOURCE_RESOLVED', info: validSourceInfo });
    s = installWizardReducer(s, { type: 'MODE_CONFIRM' });
    s = installWizardReducer(s, { type: 'PREVIEW_READY', preview: p });
    s = installWizardReducer(s, { type: 'CONFIRM_INSTALL' });
    s = typeCollision(s, 'commit-helper-renamed');
    s = installWizardReducer(s, { type: 'COLLISION_RENAME' });
    expect(s.phase).toBe('confirming');
    expect(s.name).toBe('commit-helper-renamed');
    expect(s.collisionResolution).toBe('rename');
  });

  it('collision rename refuses an empty name', () => {
    const p = preview({ collides: true, existingNames: ['commit-helper'] });
    let s = start();
    s = typeSource(s, '/x');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    s = installWizardReducer(s, { type: 'SOURCE_RESOLVED', info: validSourceInfo });
    s = installWizardReducer(s, { type: 'MODE_CONFIRM' });
    s = installWizardReducer(s, { type: 'PREVIEW_READY', preview: p });
    s = installWizardReducer(s, { type: 'CONFIRM_INSTALL' });
    // Clear the prefilled suggestion.
    for (let i = 0; i < 'commit-helper-2'.length; i++) {
      s = installWizardReducer(s, { type: 'COLLISION_BACKSPACE' });
    }
    s = installWizardReducer(s, { type: 'COLLISION_RENAME' });
    expect(s.phase).toBe('collision');
    expect(s.collisionError.length).toBeGreaterThan(0);
  });

  it('FALLBACK_TO_COPY switches a link-incapable confirm back to copy and re-previews', () => {
    const p: InstallPreview = {
      ...preview(),
      mode: 'link',
      checks: [
        { code: 'source-readable', ok: true, message: 'source readable' },
        { code: 'skill-md-present', ok: true, message: 'SKILL.md present' },
        { code: 'platform-can-link', ok: false, message: 'platform cannot create links' },
        { code: 'target-not-self-referential', ok: true, message: 'ok' },
      ],
      canInstall: false,
    };
    let s = start();
    s = typeSource(s, '/x');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    s = installWizardReducer(s, { type: 'SOURCE_RESOLVED', info: validSourceInfo });
    s = installWizardReducer(s, { type: 'SELECT_MODE', mode: 'link' });
    s = installWizardReducer(s, { type: 'MODE_CONFIRM' });
    s = installWizardReducer(s, { type: 'PREVIEW_READY', preview: p });
    expect(s.mode).toBe('link');
    s = installWizardReducer(s, { type: 'FALLBACK_TO_COPY' });
    expect(s.mode).toBe('copy');
    expect(s.phase).toBe('confirming');
  });

  it('install success and error transitions', () => {
    let s = start();
    s = typeSource(s, '/x');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    s = installWizardReducer(s, { type: 'SOURCE_RESOLVED', info: validSourceInfo });
    s = installWizardReducer(s, { type: 'MODE_CONFIRM' });
    s = installWizardReducer(s, { type: 'PREVIEW_READY', preview: preview() });
    s = installWizardReducer(s, { type: 'CONFIRM_INSTALL' });
    s = installWizardReducer(s, { type: 'INSTALL_SUCCESS', message: 'installed' });
    expect(s.phase).toBe('success');
    expect(s.message).toBe('installed');
    s = installWizardReducer(s, { type: 'DISMISS' });
    expect(s.open).toBe(false);

    // error path
    s = start();
    s = typeSource(s, '/x');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    s = installWizardReducer(s, { type: 'SOURCE_RESOLVED', info: validSourceInfo });
    s = installWizardReducer(s, { type: 'MODE_CONFIRM' });
    s = installWizardReducer(s, { type: 'PREVIEW_READY', preview: preview() });
    s = installWizardReducer(s, { type: 'CONFIRM_INSTALL' });
    s = installWizardReducer(s, { type: 'INSTALL_ERROR', message: 'boom' });
    expect(s.phase).toBe('error');
    s = installWizardReducer(s, { type: 'DISMISS' });
    expect(s.open).toBe(false);
  });

  it('esc walks back one decision per screen and closes from source', () => {
    // source → closed
    let s = start();
    s = installWizardReducer(s, { type: 'CANCEL' });
    expect(s.open).toBe(false);

    // mode → source
    s = start();
    s = typeSource(s, '/x');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    s = installWizardReducer(s, { type: 'SOURCE_RESOLVED', info: validSourceInfo });
    s = installWizardReducer(s, { type: 'CANCEL' });
    expect(s.phase).toBe('source');

    // confirm → mode
    s = start();
    s = typeSource(s, '/x');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    s = installWizardReducer(s, { type: 'SOURCE_RESOLVED', info: validSourceInfo });
    s = installWizardReducer(s, { type: 'MODE_CONFIRM' });
    s = installWizardReducer(s, { type: 'PREVIEW_READY', preview: preview() });
    s = installWizardReducer(s, { type: 'CANCEL' });
    expect(s.phase).toBe('mode');

    // collision → confirm
    const p = preview({ collides: true, existingNames: ['commit-helper'] });
    s = start();
    s = typeSource(s, '/x');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    s = installWizardReducer(s, { type: 'SOURCE_RESOLVED', info: validSourceInfo });
    s = installWizardReducer(s, { type: 'MODE_CONFIRM' });
    s = installWizardReducer(s, { type: 'PREVIEW_READY', preview: p });
    s = installWizardReducer(s, { type: 'CONFIRM_INSTALL' });
    expect(s.phase).toBe('collision');
    s = installWizardReducer(s, { type: 'CANCEL' });
    expect(s.phase).toBe('confirm');
  });

  it('cannot cancel mid-install', () => {
    let s = start();
    s = typeSource(s, '/x');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    s = installWizardReducer(s, { type: 'SOURCE_RESOLVED', info: validSourceInfo });
    s = installWizardReducer(s, { type: 'MODE_CONFIRM' });
    s = installWizardReducer(s, { type: 'PREVIEW_READY', preview: preview() });
    s = installWizardReducer(s, { type: 'CONFIRM_INSTALL' });
    expect(s.phase).toBe('installing');
    s = installWizardReducer(s, { type: 'CANCEL' });
    expect(s.phase).toBe('installing');
  });
});
