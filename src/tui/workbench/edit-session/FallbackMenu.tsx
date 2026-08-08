import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import pc from 'picocolors';

import { useI18n } from '../i18n/react';
import { useCapture } from '../capture-context';

interface FallbackMenuProps {
  /** Failure reason from the edit session; null renders nothing. */
  reason: string | null;
  /** Absolute path of the file that failed to open. */
  filePath: string;
  /** [1] open the file in the OS default editor. */
  onSystemEditor?: () => void;
  /** [3] retry the configured editor after fixing the install. */
  onRetry?: () => void;
  /** Esc — dismiss the menu and end the edit session. */
  onDismiss?: () => void;
}

/** The fallback actions, keyed by file path, threaded from the app level to
 *  whichever surface renders the failed session's FallbackMenu. */
export type EditFallbackHandlers = {
  systemEditor: (filePath: string) => void;
  retry: (filePath: string) => void;
  dismiss: (filePath: string) => void;
};

/**
 * VS Code unavailable (spec §8): inline error with three fallbacks — system
 * default editor, copy the path, retry. The TUI has no clipboard access, so
 * the copy-path fallback prints the path in the panel instead.
 *
 * While visible the menu is modal: it claims capture so app/sidebar keys stay
 * suppressed and owns [1]/[2]/[3]/Esc itself.
 */
export function FallbackMenu({ reason, filePath, onSystemEditor, onRetry, onDismiss }: FallbackMenuProps) {
  const { t } = useI18n();
  const setCapture = useCapture();
  const [pathRevealed, setPathRevealed] = useState(false);
  const active = reason !== null;

  // Claim input only while a failure is surfaced; release on dismiss/remount.
  useEffect(() => {
    if (!active) return;
    setCapture(true);
    return () => setCapture(false);
  }, [active, setCapture]);

  // A new failure starts with the path hidden again.
  useEffect(() => {
    setPathRevealed(false);
  }, [reason]);

  useInput((input, key) => {
    if (key.escape) {
      onDismiss?.();
      return;
    }
    if (input === '1') {
      onSystemEditor?.();
      return;
    }
    if (input === '2') {
      setPathRevealed(true);
      return;
    }
    if (input === '3') {
      onRetry?.();
    }
  }, { isActive: active });

  if (!reason) return null;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>
          {pc.red('●')} {t('editSession.fallback.title')}: {reason}
        </Text>
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        <Text bold={!!onSystemEditor}>[1] {t('editSession.fallback.systemEditor')}</Text>
        <Text>[2] {t('editSession.fallback.copyPath')}</Text>
        <Text bold={!!onRetry}>[3] {t('editSession.fallback.retry')}</Text>
        {pathRevealed && <Text color="cyan">{filePath}</Text>}
      </Box>
    </Box>
  );
}
