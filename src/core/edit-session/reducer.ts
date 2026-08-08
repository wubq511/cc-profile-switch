import type { EditSession, SessionEvent } from './types';

export const initialSession: EditSession = {
  phase: 'idle',
  filePath: '',
  changeCount: 0,
  lastEvent: null,
  lastContent: null,
  lastUpdated: null,
  openFailedReason: null,
};

export function reduceSession(s: EditSession, e: SessionEvent): EditSession {
  switch (e.type) {
    case 'open-requested':
      if (s.phase === 'watching' || s.phase === 'missing') {
        return { ...s, lastEvent: 'Already open — VS Code re-focused' };
      }
      return {
        ...s,
        phase: 'opening',
        filePath: e.filePath,
        lastEvent: 'Opening in VS Code…',
        openFailedReason: null,
      };

    case 'open-succeeded':
      if (s.phase !== 'opening') return s;
      return {
        ...s,
        phase: 'watching',
        changeCount: 0,
        lastEvent: 'Handed off — editing in VS Code, Workbench is watching',
      };

    case 'open-failed':
      if (s.phase !== 'opening') return s;
      return {
        ...s,
        phase: 'idle',
        changeCount: 0,
        lastEvent: `VS Code unavailable: ${e.reason}`,
        openFailedReason: e.reason,
      };

    case 'file-changed':
      if (s.phase === 'watching') {
        return {
          ...s,
          changeCount: s.changeCount + 1,
          lastContent: e.content,
          lastUpdated: e.timestamp,
          lastEvent: `Saved in VS Code (change #${s.changeCount + 1})`,
        };
      }
      if (s.phase === 'missing') {
        return {
          ...s,
          phase: 'watching',
          changeCount: s.changeCount + 1,
          lastContent: e.content,
          lastUpdated: e.timestamp,
          lastEvent: 'File reappeared and changed',
        };
      }
      return {
        ...s,
        lastContent: e.content,
        lastUpdated: e.timestamp,
        lastEvent: 'Changed on disk outside an edit session',
      };

    case 'file-unlinked':
      if (s.phase === 'watching' || s.phase === 'opening') {
        return {
          ...s,
          phase: 'missing',
          lastEvent: 'File deleted or renamed — tracking paused, preview shows last known content',
        };
      }
      return { ...s, lastEvent: 'File deleted or renamed on disk' };

    case 'file-reappeared':
      if (s.phase === 'missing') {
        return {
          ...s,
          phase: 'watching',
          lastContent: e.content,
          lastUpdated: e.timestamp,
          lastEvent: 'File reappeared — watching resumed',
        };
      }
      return s;

    case 'session-ended':
      return { ...initialSession, lastEvent: 'Edit session ended' };
  }
}

export function isSessionActive(s: EditSession): boolean {
  return s.phase === 'watching' || s.phase === 'opening' || s.phase === 'missing';
}
