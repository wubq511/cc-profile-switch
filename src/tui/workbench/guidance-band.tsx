import React from 'react';
import { Box } from 'ink';

import { type ImportPreview } from '../../core/profile-import';
import { type LifecycleState } from './lifecycle';
import { type WorkbenchProfile } from './profile-data';
import {
  ErrorPanel,
  ImportPreviewPanel,
  RemoveProfilePanel,
  SaveTemplatePanel,
} from './guidance';

type GuidanceBandProps = {
  lifecycle: LifecycleState;
  importPreview: ImportPreview | null;
  importCollisionName: string;
  importNameError: boolean;
  selectedProfile: WorkbenchProfile | undefined;
  /** Reserved band height (guidanceRows from useLifecycleFlows). */
  rows: number;
};

/** Guidance dialogs: full-width, flexShrink=0 so they never shrink-clip (#29).
 *  Extracted from app.tsx (issue #89). The band is capped at its reserved
 *  height so a panel can never grow into the panes above it (#98 V6). */
export function GuidanceBand({
  lifecycle,
  importPreview,
  importCollisionName,
  importNameError,
  selectedProfile,
  rows,
}: GuidanceBandProps): React.ReactElement {
  let dialog: React.ReactElement | null = null;
  if (lifecycle.phase === 'confirm') {
    if (lifecycle.kind === 'import' && importPreview) {
      dialog = React.createElement(ImportPreviewPanel, {
        preview: importPreview,
        newName: importCollisionName,
        nameError: importNameError,
      });
    } else if (lifecycle.kind === 'save-template') {
      dialog = React.createElement(SaveTemplatePanel, {
        templateName: lifecycle.input,
        strippedCount: lifecycle.templateSummary?.strippedCount ?? 0,
      });
    } else if (selectedProfile) {
      dialog = React.createElement(RemoveProfilePanel, { profile: selectedProfile });
    }
  } else if (lifecycle.phase === 'error') {
    dialog = React.createElement(ErrorPanel, {
      message: lifecycle.message,
      code: lifecycle.errorCode,
      guidance: lifecycle.guidance,
    });
  }
  return React.createElement(
    Box,
    { flexShrink: 0, height: rows, overflow: 'hidden' },
    dialog,
  );
}
