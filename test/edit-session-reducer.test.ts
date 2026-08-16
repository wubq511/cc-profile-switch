import { describe, expect, it } from 'vitest';

import { initialSession, isSessionActive, reduceSession } from '../src/core/edit-session/reducer';
import type { EditSession } from '../src/core/edit-session/types';

const NOW = new Date('2026-08-01T12:00:00Z');

describe('edit-session reducer', () => {
  describe('initial state', () => {
    it('starts idle with no activity', () => {
      expect(initialSession.phase).toBe('idle');
      expect(initialSession.changeCount).toBe(0);
      expect(initialSession.lastEvent).toBeNull();
      expect(initialSession.lastContent).toBeNull();
      expect(initialSession.lastUpdated).toBeNull();
      expect(initialSession.openFailedReason).toBeNull();
    });
  });

  describe('open-requested', () => {
    it('transitions idle → opening', () => {
      const next = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      expect(next.phase).toBe('opening');
      expect(next.filePath).toBe('/tmp/test.md');
      expect(next.lastEvent).toBe('Opening in VS Code…');
    });

    it('no-ops when already watching', () => {
      const watching: EditSession = { ...initialSession, phase: 'watching', filePath: '/tmp/test.md' };
      const next = reduceSession(watching, { type: 'open-requested', filePath: '/tmp/test.md' });
      expect(next.phase).toBe('watching');
      expect(next.lastEvent).toBe('Already open — VS Code re-focused');
    });

    it('no-ops when in missing state', () => {
      const missing: EditSession = { ...initialSession, phase: 'missing', filePath: '/tmp/test.md' };
      const next = reduceSession(missing, { type: 'open-requested', filePath: '/tmp/test.md' });
      expect(next.phase).toBe('missing');
      expect(next.lastEvent).toBe('Already open — VS Code re-focused');
    });
  });

  describe('open-succeeded', () => {
    it('transitions opening → watching', () => {
      const opening = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      const next = reduceSession(opening, { type: 'open-succeeded' });
      expect(next.phase).toBe('watching');
      expect(next.changeCount).toBe(0);
      expect(next.lastEvent).toBe('Handed off — editing in VS Code, Workbench is watching');
    });

    it('no-ops when not in opening phase', () => {
      const next = reduceSession(initialSession, { type: 'open-succeeded' });
      expect(next).toEqual(initialSession);
    });
  });

  describe('open-failed', () => {
    it('transitions opening → idle with reason', () => {
      const opening = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      const next = reduceSession(opening, { type: 'open-failed', reason: 'not found' });
      expect(next.phase).toBe('idle');
      expect(next.openFailedReason).toBe('not found');
      expect(next.lastEvent).toBe('VS Code unavailable: not found');
    });

    it('no-ops when not in opening phase', () => {
      const next = reduceSession(initialSession, { type: 'open-failed', reason: 'x' });
      expect(next).toEqual(initialSession);
    });
  });

  describe('file-changed', () => {
    it('increments changeCount and updates content when watching', () => {
      let s = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      s = reduceSession(s, { type: 'open-succeeded' });
      s = reduceSession(s, { type: 'file-changed', content: 'new content', timestamp: NOW });
      expect(s.changeCount).toBe(1);
      expect(s.lastContent).toBe('new content');
      expect(s.lastUpdated).toBe(NOW);
      expect(s.lastEvent).toBe('Saved in VS Code (change #1)');
    });

    it('transitions missing → watching on file-changed', () => {
      let s = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      s = reduceSession(s, { type: 'open-succeeded' });
      s = reduceSession(s, { type: 'file-unlinked' });
      expect(s.phase).toBe('missing');
      s = reduceSession(s, { type: 'file-changed', content: 'reappeared', timestamp: NOW });
      expect(s.phase).toBe('watching');
      expect(s.lastContent).toBe('reappeared');
    });

    it('updates content even when idle (out-of-session change)', () => {
      const next = reduceSession(initialSession, { type: 'file-changed', content: 'x', timestamp: NOW });
      expect(next.lastContent).toBe('x');
      expect(next.lastUpdated).toBe(NOW);
      expect(next.lastEvent).toBe('Changed on disk outside an edit session');
    });

    it('accumulates multiple changes', () => {
      let s = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      s = reduceSession(s, { type: 'open-succeeded' });
      s = reduceSession(s, { type: 'file-changed', content: 'a', timestamp: NOW });
      s = reduceSession(s, { type: 'file-changed', content: 'b', timestamp: NOW });
      s = reduceSession(s, { type: 'file-changed', content: 'c', timestamp: NOW });
      expect(s.changeCount).toBe(3);
      expect(s.lastContent).toBe('c');
    });
  });

  describe('file-unlinked', () => {
    it('transitions watching → missing preserving lastContent', () => {
      let s = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      s = reduceSession(s, { type: 'open-succeeded' });
      s = reduceSession(s, { type: 'file-changed', content: 'saved content', timestamp: NOW });
      s = reduceSession(s, { type: 'file-unlinked' });
      expect(s.phase).toBe('missing');
      expect(s.lastContent).toBe('saved content');
    });

    it('transitions opening → missing', () => {
      const opening = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      const next = reduceSession(opening, { type: 'file-unlinked' });
      expect(next.phase).toBe('missing');
    });

    it('records event when idle', () => {
      const next = reduceSession(initialSession, { type: 'file-unlinked' });
      expect(next.phase).toBe('idle');
      expect(next.lastEvent).toBe('File deleted or renamed on disk');
    });
  });

  describe('file-reappeared', () => {
    it('transitions missing → watching', () => {
      let s = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      s = reduceSession(s, { type: 'open-succeeded' });
      s = reduceSession(s, { type: 'file-unlinked' });
      s = reduceSession(s, { type: 'file-reappeared', content: 'back', timestamp: NOW });
      expect(s.phase).toBe('watching');
      expect(s.lastContent).toBe('back');
      expect(s.lastEvent).toBe('File reappeared — watching resumed');
    });

    it('no-ops when not in missing phase', () => {
      const next = reduceSession(initialSession, { type: 'file-reappeared', content: 'x', timestamp: NOW });
      expect(next).toEqual(initialSession);
    });
  });

  describe('session-ended', () => {
    it('resets to initial state', () => {
      let s = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      s = reduceSession(s, { type: 'open-succeeded' });
      s = reduceSession(s, { type: 'file-changed', content: 'x', timestamp: NOW });
      s = reduceSession(s, { type: 'session-ended' });
      expect(s.phase).toBe('idle');
      expect(s.changeCount).toBe(0);
      expect(s.lastContent).toBeNull();
      expect(s.lastEvent).toBe('Edit session ended');
    });
  });

  describe('isSessionActive', () => {
    it('returns true for watching, opening, missing', () => {
      expect(isSessionActive({ ...initialSession, phase: 'watching' })).toBe(true);
      expect(isSessionActive({ ...initialSession, phase: 'opening' })).toBe(true);
      expect(isSessionActive({ ...initialSession, phase: 'missing' })).toBe(true);
    });

    it('returns false for idle', () => {
      expect(isSessionActive(initialSession)).toBe(false);
    });
  });

  describe('full lifecycle', () => {
    it('idle → opening → watching → missing → watching → idle', () => {
      let s = initialSession;
      s = reduceSession(s, { type: 'open-requested', filePath: '/tmp/test.md' });
      expect(s.phase).toBe('opening');
      s = reduceSession(s, { type: 'open-succeeded' });
      expect(s.phase).toBe('watching');
      s = reduceSession(s, { type: 'file-changed', content: 'v1', timestamp: NOW });
      expect(s.changeCount).toBe(1);
      s = reduceSession(s, { type: 'file-unlinked' });
      expect(s.phase).toBe('missing');
      expect(s.lastContent).toBe('v1');
      s = reduceSession(s, { type: 'file-reappeared', content: 'v2', timestamp: NOW });
      expect(s.phase).toBe('watching');
      s = reduceSession(s, { type: 'session-ended' });
      expect(s.phase).toBe('idle');
    });
  });
});
