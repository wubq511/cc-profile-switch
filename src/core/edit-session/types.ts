export type SessionPhase = 'idle' | 'opening' | 'watching' | 'missing';

export interface EditSession {
  phase: SessionPhase;
  /** absolute path of the watched file */
  filePath: string;
  /** how many external saves were observed since handoff */
  changeCount: number;
  /** human-readable last lifecycle event */
  lastEvent: string | null;
  /** last successfully read file content (for missing-state display) */
  lastContent: string | null;
  /** timestamp of last external save */
  lastUpdated: Date | null;
  /** reason for VS Code unavailability (for fallback menu) */
  openFailedReason: string | null;
}

export type SessionEvent =
  | { type: 'open-requested'; filePath: string }
  | { type: 'open-succeeded' }
  | { type: 'open-failed'; reason: string }
  | { type: 'file-changed'; content: string; timestamp: Date }
  | { type: 'file-unlinked' }
  | { type: 'file-reappeared'; content: string; timestamp: Date }
  | { type: 'session-ended' };
