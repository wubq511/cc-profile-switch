// PROTOTYPE (throwaway) — issue #31: VS Code edit handoff + live refresh.
// Pure state machine for one resource's external-edit session. No I/O, no
// terminal code — the Ink shell drives it with real fs.watch / spawn events.
// The question: how does a Workbench edit session lifecycle feel when the file
// is changed, deleted, or renamed in VS Code, and when VS Code is unavailable?

export type SessionPhase = 'idle' | 'opening' | 'watching' | 'missing';

export interface EditSession {
  phase: SessionPhase;
  /** how many external saves were observed since handoff */
  changeCount: number;
  /** human-readable last lifecycle event, shown as the status line */
  lastEvent: string | null;
}

export type SessionEvent =
  | { type: 'open-requested' }
  | { type: 'open-succeeded' }
  | { type: 'open-failed'; reason: string }
  | { type: 'file-changed' }
  | { type: 'file-unlinked' } // deleted, or renamed away — indistinguishable from a dir watch
  | { type: 'file-reappeared' } // recreated, or renamed back
  | { type: 'session-ended' }; // user dismissed the handoff

export const initialSession: EditSession = {
  phase: 'idle',
  changeCount: 0,
  lastEvent: null,
};

export function reduceSession(s: EditSession, e: SessionEvent): EditSession {
  switch (e.type) {
    case 'open-requested':
      if (s.phase === 'watching' || s.phase === 'missing') {
        return { ...s, lastEvent: 'Already open — VS Code re-focused' };
      }
      return { ...s, phase: 'opening', lastEvent: 'Opening in VS Code…' };

    case 'open-succeeded':
      if (s.phase !== 'opening') return s;
      return {
        phase: 'watching',
        changeCount: 0,
        lastEvent: 'Handed off — editing happens in VS Code, Workbench is watching',
      };

    case 'open-failed':
      if (s.phase !== 'opening') return s;
      return { phase: 'idle', changeCount: 0, lastEvent: `VS Code unavailable: ${e.reason}` };

    case 'file-changed':
      if (s.phase === 'watching') {
        return {
          ...s,
          changeCount: s.changeCount + 1,
          lastEvent: `Saved in VS Code (change #${s.changeCount + 1})`,
        };
      }
      if (s.phase === 'missing') {
        // a change event for a path we thought was gone means it is back
        return { phase: 'watching', changeCount: s.changeCount + 1, lastEvent: 'File reappeared and changed' };
      }
      // idle: file changed outside any session — still worth surfacing
      return { ...s, lastEvent: 'Changed on disk outside an edit session' };

    case 'file-unlinked':
      if (s.phase === 'watching' || s.phase === 'opening') {
        return {
          ...s,
          phase: 'missing',
          lastEvent: 'File deleted or renamed in VS Code — tracking lost, preview shows last known content',
        };
      }
      return { ...s, lastEvent: 'File deleted or renamed on disk' };

    case 'file-reappeared':
      if (s.phase === 'missing') {
        return { ...s, phase: 'watching', lastEvent: 'File reappeared — watching resumed' };
      }
      return s;

    case 'session-ended':
      return { ...initialSession, lastEvent: 'Edit session ended' };
  }
}
