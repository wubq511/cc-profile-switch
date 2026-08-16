// Shared bordered shell for guidance dialogs (issue #76 §5).
// flexShrink={0} keeps Yoga from clipping the first row (prototype note, #29).
// Both the error panel and the destructive panel are the same round box; only
// the border colour and content differ.

import React from 'react';
import { Box } from 'ink';

type GuidancePanelProps = {
  borderColor: 'red' | 'yellow';
  children: React.ReactNode;
};

export function GuidancePanel({ borderColor, children }: GuidancePanelProps): React.ReactElement {
  return React.createElement(
    Box,
    { flexShrink: 0, flexDirection: 'column', borderStyle: 'round', borderColor, paddingX: 1 },
    children,
  );
}
