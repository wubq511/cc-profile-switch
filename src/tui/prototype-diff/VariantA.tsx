// PROTOTYPE (throwaway) — Variant A: "Format follows resource".
// One pairwise Diff entry point; each Managed Profile Resource renders in the
// presentation that fits its shape (see resourceDiff.tsx). The cross-Profile
// question is answered by counterpart switching (←/→).
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PROFILES } from './data';
import ResourceDiff, { RESOURCES } from './resourceDiff';

export default function VariantA() {
  const [ri, setRi] = useState(0);
  const [bi, setBi] = useState(1); // counterpart index into PROFILES
  const base = PROFILES[0];
  const other = PROFILES[bi];

  useInput((input, key) => {
    if (key.upArrow) setRi((i) => (i - 1 + RESOURCES.length) % RESOURCES.length);
    if (key.downArrow) setRi((i) => (i + 1) % RESOURCES.length);
    if (key.leftArrow) setBi((i) => (i - 1 + PROFILES.length) % PROFILES.length || 1);
    if (key.rightArrow) setBi((i) => (i + 1) % PROFILES.length || 1);
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        <Text bold color="cyan">
          Diff · {base.name} ↔ {other.name}
        </Text>
        <Text dimColor>   [←/→] counterpart: {PROFILES.filter((_, i) => i !== 0).map((p) => p.name).join(' / ')}</Text>
      </Box>
      <Box flexGrow={1} marginTop={1}>
        <Box flexDirection="column" width={18} borderStyle="single" borderColor="gray" paddingX={1}>
          {RESOURCES.map((r, i) => (
            <Text key={r} color={i === ri ? 'cyan' : undefined} bold={i === ri}>
              {i === ri ? '▸' : ' '} {r}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" flexGrow={1} paddingX={2}>
          <ResourceDiff res={RESOURCES[ri]} a={base} b={other} />
        </Box>
      </Box>
      <Text dimColor>[↑/↓] resource · [←/→] counterpart</Text>
    </Box>
  );
}
