// PROTOTYPE (throwaway) — Variant C: "Comparison matrix first".
// Cross-Profile comparison is the primary surface: resources × Profiles grid,
// each cell a content fingerprint — equal cells share a mark, differing cells
// stand out. Enter marks a base cell, Enter on a second cell drills into the
// pairwise diff for that resource (reusing Variant A's per-resource views);
// Esc returns. The pairwise diff is a drill-down, not the entry point.
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PROFILES, type DiffProfile } from './data';
import ResourceDiff from './resourceDiff';

const RESOURCES = ['User Memory', 'Agents', 'Settings', 'MCP', 'Skills', 'Launch config'] as const;

// Cheap stand-in for a real content fingerprint: stable 3-char tag.
function fingerprint(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 3).padStart(3, '0');
}

function resourceFingerprint(p: DiffProfile, res: (typeof RESOURCES)[number]): string {
  switch (res) {
    case 'User Memory':
      return fingerprint(p.userMemory.join('\n'));
    case 'Agents':
      return fingerprint(
        Object.keys(p.agents)
          .sort()
          .map((n) => n + p.agents[n].join('\n'))
          .join('|'),
      );
    case 'Settings':
      return fingerprint(JSON.stringify(p.settings, Object.keys(p.settings).sort()));
    case 'MCP':
      return fingerprint(p.mcp.map((s) => `${s.name}${s.transport}`).join('|')); // status excluded: runtime, not config
    case 'Skills':
      return fingerprint(p.skills.map((s) => s.name + s.profileFiles.map((f) => f.path + f.hash).join(',')).join('|'));
    case 'Launch config':
      return fingerprint(JSON.stringify(p.launch, Object.keys(p.launch).sort()));
  }
}

const GROUP_COLORS = ['green', 'yellow', 'magenta', 'cyan', 'red'];

export default function VariantC() {
  const [row, setRow] = useState(0);
  const [col, setCol] = useState(0);
  const [mark, setMark] = useState<{ row: number; col: number } | null>(null);
  const [drill, setDrill] = useState<{ res: (typeof RESOURCES)[number]; a: DiffProfile; b: DiffProfile } | null>(null);

  useInput((input, key) => {
    if (drill) {
      if (key.escape) setDrill(null);
      return;
    }
    if (key.upArrow) setRow((r) => Math.max(0, r - 1));
    if (key.downArrow) setRow((r) => Math.min(RESOURCES.length - 1, r + 1));
    if (key.leftArrow) setCol((c) => Math.max(0, c - 1));
    if (key.rightArrow) setCol((c) => Math.min(PROFILES.length - 1, c + 1));
    if (key.escape) {
      setMark(null);
      return;
    }
    if (key.return) {
      if (!mark) {
        setMark({ row, col });
        return;
      }
      if (mark.row === row && mark.col === col) {
        setMark(null);
        return;
      }
      if (mark.row !== row) return; // cross-resource comparison is meaningless
      setDrill({ res: RESOURCES[row], a: PROFILES[mark.col], b: PROFILES[col] });
      setMark(null);
    }
  });

  if (drill) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text bold color="cyan">
          {drill.res} · {drill.a.name} ↔ {drill.b.name}
        </Text>
        <Box flexDirection="column" flexGrow={1} marginTop={1} paddingX={1}>
          <ResourceDiff res={drill.res} a={drill.a} b={drill.b} />
        </Box>
        <Text dimColor>[Esc] back to matrix</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color="cyan">
        Compare · {PROFILES.length} Profiles
      </Text>
      <Box flexDirection="column" marginTop={1} paddingX={1}>
        <Box>
          <Box width={16}>
            <Text> </Text>
          </Box>
          {PROFILES.map((p, ci) => (
            <Box key={p.name} width={16}>
              <Text bold color={ci === col ? 'cyan' : undefined}>
                {ci === col ? '▸' : ' '} {p.name}
              </Text>
            </Box>
          ))}
        </Box>
        {RESOURCES.map((res, ri) => {
          const fps = PROFILES.map((p) => resourceFingerprint(p, res));
          const groups = [...new Set(fps)];
          return (
            <Box key={res}>
              <Box width={16}>
                <Text color={ri === row ? 'cyan' : undefined} bold={ri === row}>
                  {ri === row ? '▸' : ' '} {res}
                </Text>
              </Box>
              {fps.map((fp, ci) => {
                const allSame = groups.length === 1;
                const color = allSame ? 'gray' : GROUP_COLORS[groups.indexOf(fp) % GROUP_COLORS.length];
                const here = ri === row && ci === col;
                const marked = mark && mark.row === ri && mark.col === ci;
                return (
                  <Box key={ci} width={16}>
                    <Text color={color} bold={here} inverse={here} wrap="truncate">
                      {marked ? '◆' : allSame ? '=' : '≠'} {fp}
                      {marked ? ' base' : ''}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>= all Profiles identical · ≠ fingerprints differ · status excluded from MCP fingerprint</Text>
        <Text dimColor>[↑↓←→] move · [Enter] mark base cell, then Enter on another cell to drill · [Esc] unmark</Text>
      </Box>
    </Box>
  );
}
