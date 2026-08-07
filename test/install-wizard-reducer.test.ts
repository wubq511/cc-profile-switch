import { describe, expect, it } from 'vitest';

import {
  initialInstallWizardState,
  installWizardReducer,
} from '../src/tui/workbench/skills/install-wizard-reducer';
import type {
  CatalogedLocalSkillSource,
  InstallPreview,
  LocalSkillSourceInfo,
} from '../src/core/skills-install';
import type { RemoteInstallPreview } from '../src/core/skills-remote-install';

// `startAtKind()` opens the wizard to the kind picker (spec §7.3: Local|Remote).
// `startAtSourceList()` selects Local, landing on the step-1 pick list (spec
// §7.2: pick the Local Skill Source from a list). `start()` additionally picks
// the manual-entry row, landing on the typed-path step — this is what the bulk
// of the local-flow tests want, so they stay readable.
function startAtKind(): ReturnType<typeof initialInstallWizardState> {
  return installWizardReducer(initialInstallWizardState(), { type: 'START', profileName: 'coding' });
}

function startAtSourceList(): ReturnType<typeof initialInstallWizardState> {
  return installWizardReducer(startAtKind(), { type: 'KIND_SELECT_LOCAL' });
}

function start(): ReturnType<typeof initialInstallWizardState> {
  // Empty source list (not yet loaded) → the only row is manual entry.
  return installWizardReducer(startAtSourceList(), { type: 'SOURCE_LIST_PICK' });
}

function startRemote(): ReturnType<typeof initialInstallWizardState> {
  return installWizardReducer(startAtKind(), { type: 'KIND_SELECT_REMOTE' });
}

// The Discover-surface entry (spec §7.4): stage a known remote source directly.
function startRemoteSeeded(source: string, skill?: string): ReturnType<typeof initialInstallWizardState> {
  return installWizardReducer(initialInstallWizardState(), {
    type: 'START_REMOTE',
    profileName: 'coding',
    source,
    skill,
  });
}

function typeSource(state: ReturnType<typeof initialInstallWizardState>, text: string) {
  let s = state;
  for (const ch of text) s = installWizardReducer(s, { type: 'SOURCE_CHAR', char: ch });
  return s;
}

function typeRemoteSource(state: ReturnType<typeof initialInstallWizardState>, text: string) {
  let s = state;
  for (const ch of text) s = installWizardReducer(s, { type: 'REMOTE_SOURCE_CHAR', char: ch });
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
  it('starts closed and opens on START at the kind picker with Copy pre-selected', () => {
    expect(initialInstallWizardState().open).toBe(false);
    const s = startAtKind();
    expect(s.open).toBe(true);
    expect(s.phase).toBe('kind'); // §7.3: kind picker (Local|Remote) is the entry screen
    expect(s.profileName).toBe('coding');
    expect(s.mode).toBe('copy'); // Copy is the default per spec §7.2
  });

  it('KIND_SELECT_LOCAL lands on the source-list step (spec §7.2 step 1)', () => {
    const s = startAtSourceList();
    expect(s.phase).toBe('source-list');
    expect(s.kind).toBe('local');
    // The manual-entry row is the typed-path fallback.
    const manual = installWizardReducer(s, { type: 'SOURCE_LIST_PICK' });
    expect(manual.phase).toBe('source');
    expect(manual.kind).toBe('local');
  });

  it('KIND_SELECT_REMOTE lands on the remote source step', () => {
    const s = startRemote();
    expect(s.phase).toBe('source-remote');
    expect(s.kind).toBe('remote');
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

  it('esc walks back one decision per screen and closes from kind', () => {
    // kind → closed (the kind picker is the wizard's entry screen)
    let s = startAtKind();
    s = installWizardReducer(s, { type: 'CANCEL' });
    expect(s.open).toBe(false);

    // source-list → kind (esc walks back to the kind picker, not closed)
    s = startAtSourceList();
    s = installWizardReducer(s, { type: 'CANCEL' });
    expect(s.phase).toBe('kind');

    // source (manual entry) → source-list
    s = start();
    s = installWizardReducer(s, { type: 'CANCEL' });
    expect(s.phase).toBe('source-list');

    // mode → source-list (one decision back: the source choice)
    s = start();
    s = typeSource(s, '/x');
    s = installWizardReducer(s, { type: 'SOURCE_SUBMIT' });
    s = installWizardReducer(s, { type: 'SOURCE_RESOLVED', info: validSourceInfo });
    s = installWizardReducer(s, { type: 'CANCEL' });
    expect(s.phase).toBe('source-list');

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

  // ─── Local source pick list (spec §7.2 step 1) ────────────────────────

  describe('source list (local step 1)', () => {
    function cataloged(overrides: Partial<CatalogedLocalSkillSource> = {}): CatalogedLocalSkillSource {
      return {
        sourcePath: '/profiles/notes/claude-home/skills/grilling',
        readable: true,
        skillMdPresent: true,
        suggestedName: 'grilling',
        originProfile: 'notes',
        ...overrides,
      };
    }

    it('SOURCES_LOADED populates the pick list and marks it loaded', () => {
      let s = startAtSourceList();
      expect(s.sourcesLoaded).toBe(false);
      s = installWizardReducer(s, {
        type: 'SOURCES_LOADED',
        sources: [cataloged(), cataloged({ suggestedName: 'tdd', sourcePath: '/profiles/notes/claude-home/skills/tdd' })],
      });
      expect(s.sourcesLoaded).toBe(true);
      expect(s.localSources).toHaveLength(2);
      expect(s.phase).toBe('source-list');
    });

    it('SOURCES_LOADED is a no-op outside the source-list phase', () => {
      let s = start(); // typed manual-entry step
      s = installWizardReducer(s, { type: 'SOURCES_LOADED', sources: [cataloged()] });
      expect(s.sourcesLoaded).toBe(false);
      expect(s.localSources).toHaveLength(0);
    });

    it('SOURCE_LIST_MOVE clamps at both ends across sources + the manual row', () => {
      let s = startAtSourceList();
      s = installWizardReducer(s, {
        type: 'SOURCES_LOADED',
        sources: [cataloged(), cataloged({ suggestedName: 'tdd', sourcePath: '/x/tdd' })],
      });
      expect(s.sourceListIndex).toBe(0);
      // Up at the top clamps to 0.
      s = installWizardReducer(s, { type: 'SOURCE_LIST_MOVE', delta: -1 });
      expect(s.sourceListIndex).toBe(0);
      // Rows: 2 sources + manual = 3; down walks to the manual row and clamps.
      s = installWizardReducer(s, { type: 'SOURCE_LIST_MOVE', delta: 1 });
      s = installWizardReducer(s, { type: 'SOURCE_LIST_MOVE', delta: 1 });
      expect(s.sourceListIndex).toBe(2);
      s = installWizardReducer(s, { type: 'SOURCE_LIST_MOVE', delta: 1 });
      expect(s.sourceListIndex).toBe(2);
    });

    it('SOURCE_LIST_PICK on a source row validates the picked path', () => {
      let s = startAtSourceList();
      s = installWizardReducer(s, { type: 'SOURCES_LOADED', sources: [cataloged()] });
      s = installWizardReducer(s, { type: 'SOURCE_LIST_PICK' });
      expect(s.phase).toBe('validating');
      expect(s.sourceInput).toBe('/profiles/notes/claude-home/skills/grilling');
    });

    it('SOURCE_LIST_PICK on the manual row falls back to the typed-path step', () => {
      let s = startAtSourceList();
      s = installWizardReducer(s, { type: 'SOURCES_LOADED', sources: [cataloged()] });
      s = installWizardReducer(s, { type: 'SOURCE_LIST_MOVE', delta: 1 });
      s = installWizardReducer(s, { type: 'SOURCE_LIST_PICK' });
      expect(s.phase).toBe('source');
      // Typed input is preserved (empty here) for manual entry.
      expect(s.sourceInput).toBe('');
    });

    it('esc from validating returns to the source list', () => {
      let s = startAtSourceList();
      s = installWizardReducer(s, { type: 'SOURCES_LOADED', sources: [cataloged()] });
      s = installWizardReducer(s, { type: 'SOURCE_LIST_PICK' });
      expect(s.phase).toBe('validating');
      s = installWizardReducer(s, { type: 'CANCEL' });
      expect(s.phase).toBe('source-list');
    });

    it('a picked source that fails validation lands on the typed step with the error', () => {
      let s = startAtSourceList();
      s = installWizardReducer(s, { type: 'SOURCES_LOADED', sources: [cataloged()] });
      s = installWizardReducer(s, { type: 'SOURCE_LIST_PICK' });
      s = installWizardReducer(s, { type: 'SOURCE_INVALID', message: 'no SKILL.md' });
      expect(s.phase).toBe('source');
      expect(s.sourceError).toBe('no SKILL.md');
      // The picked path is prefilled for editing.
      expect(s.sourceInput).toBe('/profiles/notes/claude-home/skills/grilling');
    });
  });

  // ─── Remote flow (spec §7.3) ──────────────────────────────────────────
  describe('remote flow', () => {
    function remotePreview(overrides: Partial<RemoteInstallPreview> = {}): RemoteInstallPreview {
      return {
        name: 'find-skills',
        targetPath: '/profiles/coding/claude-home/skills/find-skills',
        stagingRoot: '/profiles/coding/.ccps-remote-stage-abc123',
        stagedName: 'find-skills',
        identity: { name: 'find-skills', description: 'Locate skills.' },
        provenanceSource: { kind: 'git-remote', url: 'vercel-labs/skills' },
        previewLines: [
          'acquire  vercel-labs/skills  →  staging',
          'stage    find-skills/  (frontmatter name: find-skills)',
          'create   /target/   (snapshot — Profile-owned)',
          'record   skills-provenance.json  ← copy · source git-remote · sha256 fingerprint',
        ],
        collides: false,
        existingIsLink: false,
        existingNames: [],
        ...overrides,
      };
    }

    it('accumulates remote source input and submits to staging', () => {
      let s = startRemote();
      s = typeRemoteSource(s, 'vercel-labs/skills');
      expect(s.remoteSourceInput).toBe('vercel-labs/skills');
      s = installWizardReducer(s, { type: 'REMOTE_SOURCE_SUBMIT' });
      expect(s.phase).toBe('staging');
    });

    it('START_REMOTE stages a pre-seeded source directly (Discover entry)', () => {
      const s = startRemoteSeeded('github/awesome-copilot', 'git-commit');
      expect(s.open).toBe(true);
      expect(s.phase).toBe('staging');
      expect(s.kind).toBe('remote');
      expect(s.remoteSourceInput).toBe('github/awesome-copilot');
      expect(s.remoteSkill).toBe('git-commit');
    });

    it('START_REMOTE without a skill stages the source with no --skill selection', () => {
      const s = startRemoteSeeded('https://github.com/vercel-labs/skills/tree/main/skills/find-skills');
      expect(s.phase).toBe('staging');
      expect(s.remoteSkill).toBeNull();
    });

    it('esc from a Discover-seeded staging returns to the remote source step', () => {
      let s = startRemoteSeeded('github/awesome-copilot', 'git-commit');
      s = installWizardReducer(s, { type: 'CANCEL' });
      expect(s.phase).toBe('source-remote');
      expect(s.remoteSourceInput).toBe('github/awesome-copilot');
    });

    it('ignores REMOTE_SOURCE_SUBMIT on empty input', () => {
      let s = startRemote();
      s = installWizardReducer(s, { type: 'REMOTE_SOURCE_SUBMIT' });
      expect(s.phase).toBe('source-remote');
    });

    it('staging success without collision lands on confirm with stagingRoot + stagedName set', () => {
      let s = startRemote();
      s = typeRemoteSource(s, 'vercel-labs/skills');
      s = installWizardReducer(s, { type: 'REMOTE_SOURCE_SUBMIT' });
      s = installWizardReducer(s, { type: 'REMOTE_STAGED', preview: remotePreview() });
      expect(s.phase).toBe('confirm');
      expect(s.stagingRoot).toBe('/profiles/coding/.ccps-remote-stage-abc123');
      expect(s.stagedName).toBe('find-skills');
      expect(s.remotePreview?.identity.name).toBe('find-skills');
      expect(s.collisionResolution).toBeNull();
    });

    it('staging success with collision lands on collision with a suggested rename', () => {
      const p = remotePreview({ collides: true, existingNames: ['find-skills'] });
      let s = startRemote();
      s = typeRemoteSource(s, 'vercel-labs/skills');
      s = installWizardReducer(s, { type: 'REMOTE_SOURCE_SUBMIT' });
      s = installWizardReducer(s, { type: 'REMOTE_STAGED', preview: p });
      expect(s.phase).toBe('collision');
      expect(s.collisionInput).toBe('find-skills-2');
      expect(s.stagingRoot).toBe(p.stagingRoot);
    });

    it('staging failure returns to source-remote with an error', () => {
      let s = startRemote();
      s = typeRemoteSource(s, 'vercel-labs/skills');
      s = installWizardReducer(s, { type: 'REMOTE_SOURCE_SUBMIT' });
      s = installWizardReducer(s, {
        type: 'REMOTE_STAGING_FAILED',
        message: 'SKILLS_ACQUISITION_OFFLINE: offline',
      });
      expect(s.phase).toBe('source-remote');
      expect(s.remoteSourceError).toContain('SKILLS_ACQUISITION_OFFLINE');
    });

    it('confirm → installing when there is no collision', () => {
      let s = startRemote();
      s = typeRemoteSource(s, 'vercel-labs/skills');
      s = installWizardReducer(s, { type: 'REMOTE_SOURCE_SUBMIT' });
      s = installWizardReducer(s, { type: 'REMOTE_STAGED', preview: remotePreview() });
      s = installWizardReducer(s, { type: 'CONFIRM_INSTALL' });
      expect(s.phase).toBe('installing');
      expect(s.collisionResolution).toBeNull();
    });

    it('confirm → collision when the staged name already exists', () => {
      const p = remotePreview({ collides: true, existingNames: ['find-skills'] });
      let s = startRemote();
      s = typeRemoteSource(s, 'vercel-labs/skills');
      s = installWizardReducer(s, { type: 'REMOTE_SOURCE_SUBMIT' });
      s = installWizardReducer(s, { type: 'REMOTE_STAGED', preview: p });
      // After REMOTE_STAGED with a collision, the wizard is already on collision.
      // Walk back to confirm, then re-trigger CONFIRM_INSTALL to verify the gate.
      s = installWizardReducer(s, { type: 'CANCEL' }); // collision → confirm
      expect(s.phase).toBe('confirm');
      s = installWizardReducer(s, { type: 'CONFIRM_INSTALL' });
      expect(s.phase).toBe('collision');
    });

    it('collision replace installs with collisionResolution=replace', () => {
      const p = remotePreview({ collides: true, existingNames: ['find-skills'] });
      let s = startRemote();
      s = typeRemoteSource(s, 'vercel-labs/skills');
      s = installWizardReducer(s, { type: 'REMOTE_SOURCE_SUBMIT' });
      s = installWizardReducer(s, { type: 'REMOTE_STAGED', preview: p });
      expect(s.phase).toBe('collision');
      s = installWizardReducer(s, { type: 'COLLISION_REPLACE' });
      expect(s.phase).toBe('installing');
      expect(s.collisionResolution).toBe('replace');
    });

    it('collision rename applies the typed name without re-acquiring (pure preview rebuild)', () => {
      const p = remotePreview({
        collides: true,
        existingNames: ['find-skills'],
        // The reducer uses profileRootPath to recompute the target on rename.
      });
      let s = installWizardReducer(startAtKind(), { type: 'KIND_SELECT_REMOTE' });
      // Inject a profileRootPath so the rename path recomputation has a base.
      s = { ...s, profileRootPath: '/profiles/coding' };
      s = typeRemoteSource(s, 'vercel-labs/skills');
      s = installWizardReducer(s, { type: 'REMOTE_SOURCE_SUBMIT' });
      s = installWizardReducer(s, { type: 'REMOTE_STAGED', preview: p });
      expect(s.phase).toBe('collision');
      s = typeCollision(s, 'find-skills-renamed');
      s = installWizardReducer(s, { type: 'COLLISION_RENAME' });
      expect(s.phase).toBe('confirm');
      expect(s.name).toBe('find-skills-renamed');
      expect(s.collisionResolution).toBe('rename');
      expect(s.remotePreview?.name).toBe('find-skills-renamed');
      expect(s.remotePreview?.collides).toBe(false);
      // The staged tree is unchanged; only the target/name recomputed.
      expect(s.remotePreview?.stagedName).toBe('find-skills');
    });

    it('collision rename refuses an empty name', () => {
      const p = remotePreview({ collides: true, existingNames: ['find-skills'] });
      let s = startRemote();
      s = typeRemoteSource(s, 'vercel-labs/skills');
      s = installWizardReducer(s, { type: 'REMOTE_SOURCE_SUBMIT' });
      s = installWizardReducer(s, { type: 'REMOTE_STAGED', preview: p });
      // Clear the prefilled suggestion.
      for (let i = 0; i < 'find-skills-2'.length; i++) {
        s = installWizardReducer(s, { type: 'COLLISION_BACKSPACE' });
      }
      s = installWizardReducer(s, { type: 'COLLISION_RENAME' });
      expect(s.phase).toBe('collision');
      expect(s.collisionError.length).toBeGreaterThan(0);
    });

    it('install success clears the staging root reference', () => {
      let s = startRemote();
      s = typeRemoteSource(s, 'vercel-labs/skills');
      s = installWizardReducer(s, { type: 'REMOTE_SOURCE_SUBMIT' });
      s = installWizardReducer(s, { type: 'REMOTE_STAGED', preview: remotePreview() });
      s = installWizardReducer(s, { type: 'CONFIRM_INSTALL' });
      expect(s.stagingRoot).not.toBeNull();
      s = installWizardReducer(s, { type: 'INSTALL_SUCCESS', message: 'installed' });
      expect(s.phase).toBe('success');
      expect(s.stagingRoot).toBeNull();
    });

    it('install error keeps the staging root reference (component cleans up)', () => {
      let s = startRemote();
      s = typeRemoteSource(s, 'vercel-labs/skills');
      s = installWizardReducer(s, { type: 'REMOTE_SOURCE_SUBMIT' });
      s = installWizardReducer(s, { type: 'REMOTE_STAGED', preview: remotePreview() });
      s = installWizardReducer(s, { type: 'CONFIRM_INSTALL' });
      s = installWizardReducer(s, { type: 'INSTALL_ERROR', message: 'boom' });
      expect(s.phase).toBe('error');
      // Staging root is preserved so the component's abandon-cleanup effect can remove it.
      expect(s.stagingRoot).not.toBeNull();
    });

    it('esc walks back: source-remote → kind, staging → source-remote, confirm → source-remote', () => {
      // source-remote → kind
      let s = startRemote();
      s = installWizardReducer(s, { type: 'CANCEL' });
      expect(s.phase).toBe('kind');

      // staging → source-remote
      s = startRemote();
      s = typeRemoteSource(s, 'vercel-labs/skills');
      s = installWizardReducer(s, { type: 'REMOTE_SOURCE_SUBMIT' });
      s = installWizardReducer(s, { type: 'CANCEL' });
      expect(s.phase).toBe('source-remote');

      // confirm → source-remote
      s = startRemote();
      s = typeRemoteSource(s, 'vercel-labs/skills');
      s = installWizardReducer(s, { type: 'REMOTE_SOURCE_SUBMIT' });
      s = installWizardReducer(s, { type: 'REMOTE_STAGED', preview: remotePreview() });
      expect(s.phase).toBe('confirm');
      s = installWizardReducer(s, { type: 'CANCEL' });
      expect(s.phase).toBe('source-remote');
    });

    it('local-only actions are no-ops in remote phases', () => {
      // SOURCE_CHAR / SELECT_MODE / FALLBACK_TO_COPY must not fire on remote phases.
      let s = startRemote();
      s = installWizardReducer(s, { type: 'SOURCE_CHAR', char: 'x' });
      expect(s.sourceInput).toBe('');
      s = installWizardReducer(s, { type: 'SELECT_MODE', mode: 'link' });
      expect(s.mode).toBe('copy'); // unchanged
      s = installWizardReducer(s, { type: 'FALLBACK_TO_COPY' });
      expect(s.phase).toBe('source-remote'); // unchanged
    });
  });
});
