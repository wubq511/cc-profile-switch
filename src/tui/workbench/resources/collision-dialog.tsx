import React, { useReducer } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';

import { useI18n } from '../i18n/react';
import { collisionDialogReducer, initialCollisionDialogState } from './collision-dialog-reducer';

/**
 * A collision on a Bin restore offers three paths beyond plain refuse
 * (spec §9.3): restore-as-new-name (with a name prompt) and an inline
 * delete-and-restore (one confirm). The resolution is reported back to the
 * caller, which owns the actual `restoreRecoveryItem` invocation — this
 * component knows nothing about resource types, so every resource row can
 * embed it. It is an inline flow panel: the embedding view owns the region.
 */
export type CollisionResolutionChoice =
  | { resolution: 'restore-as-new-name'; newName: string }
  | { resolution: 'delete-and-restore' }
  | { resolution: 'refuse' };

export type CollisionDialogProps = {
  /** Human label of the colliding resource (shown in the delete confirm). */
  resourceName: string;
  /** Suggested new name, prefilled in the rename prompt. */
  suggestedName: string;
  onResolve: (choice: CollisionResolutionChoice) => void;
  /** When true, keyboard input is disabled (headless/test rendering). */
  headless?: boolean;
};

export function CollisionDialog({
  resourceName,
  suggestedName,
  onResolve,
  headless,
}: CollisionDialogProps): React.ReactElement {
  const { t } = useI18n();
  const { stdin: inkStdin } = useStdin();
  const canUseInput = !headless && inkStdin.isTTY === true;

  const [state, dispatch] = useReducer(
    collisionDialogReducer,
    suggestedName,
    initialCollisionDialogState,
  );

  useInput(
    (input: string, key: Record<string, boolean>) => {
      if (key.ctrl && input === 'c') return; // app-level exit handles this

      if (state.phase === 'rename') {
        if (key.return) {
          const name = state.nameInput.trim();
          if (name === '') {
            dispatch({ type: 'NAME_ERROR', message: t('collision.rename.empty') });
            return;
          }
          onResolve({ resolution: 'restore-as-new-name', newName: name });
          return;
        }
        if (key.escape) {
          dispatch({ type: 'BACK' });
          return;
        }
        if (key.backspace || key.delete) {
          dispatch({ type: 'NAME_BACKSPACE' });
          return;
        }
        if (!key.ctrl && !key.meta && input.length === 1) {
          dispatch({ type: 'NAME_CHAR', char: input });
        }
        return;
      }

      if (state.phase === 'confirm-delete') {
        if (input === 'y' || input === 'Y') {
          onResolve({ resolution: 'delete-and-restore' });
          return;
        }
        if (input === 'n' || input === 'N' || key.escape) {
          dispatch({ type: 'BACK' });
        }
        return;
      }

      // choose phase
      if (key.escape) {
        onResolve({ resolution: 'refuse' });
        return;
      }
      if (input === 'r' || input === 'R') {
        dispatch({ type: 'SELECT_RESTORE_AS_NEW_NAME' });
        return;
      }
      if (input === 'd' || input === 'D') {
        dispatch({ type: 'SELECT_DELETE_AND_RESTORE' });
      }
    },
    { isActive: canUseInput },
  );

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="yellow">
          {t('collision.title')}
        </Text>
      </Box>

      {state.phase === 'rename' ? (
        <Box flexDirection="column">
          <Text bold>
            {t('collision.rename.prompt')}
            <Text color="cyan">{state.nameInput}█</Text>
          </Text>
          {state.error && <Text color="yellow">{state.error}</Text>}
          <Text dimColor>{t('collision.rename.hint')}</Text>
        </Box>
      ) : state.phase === 'confirm-delete' ? (
        <Box flexDirection="column">
          <Text>{t('collision.delete.confirm', { resource: resourceName })}</Text>
          <Text dimColor>{t('collision.delete.detail')}</Text>
          <Text dimColor>{t('collision.delete.hint')}</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>"{resourceName}"</Text>
          <Box marginTop={1} flexDirection="column">
            {/* Numbered-explanation panel (issue #94): each option is a numbered
                row whose explanation makes the consequence of the choice (and of
                the refuse-by-default fallback) explicit — never a silent overwrite. */}
            <Text wrap="wrap">
              1. {t('collision.restoreAsNewName')} — {t('collision.explain.rename')}
            </Text>
            <Text wrap="wrap">
              2. {t('collision.deleteAndRestore')} — {t('collision.explain.delete')}
            </Text>
            <Text dimColor wrap="wrap">
              3. {t('collision.refuse')} — {t('collision.explain.refuse')}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
