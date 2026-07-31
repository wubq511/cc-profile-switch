// PROTOTYPE (throwaway) — shared per-resource pairwise diff renderers.
// Variant A's core, also reused by Variant C's drill-down: line diff for text,
// redacted key table for Settings, inventory comparison for MCP, hash-tree
// for Copied Skills, plain key table for launch config.
import React from 'react';
import { Box, Text } from 'ink';
import type { DiffProfile } from './data';
import { lineDiff, keyDiff, fileDiff, type KeyVerdict, type FileVerdict } from './diffUtil';

export const RESOURCES = ['User Memory', 'Agents', 'Settings', 'MCP', 'Skills', 'Launch config'] as const;
export type ResourceName = (typeof RESOURCES)[number];

const KEY_MARK: Record<KeyVerdict, [string, string]> = {
  same: [' ', 'gray'],
  changed: ['≠', 'yellow'],
  'only-a': ['−', 'red'],
  'only-b': ['+', 'green'],
};
const FILE_MARK: Record<FileVerdict, [string, string]> = {
  same: [' ', 'gray'],
  changed: ['≠', 'yellow'],
  'only-profile': ['−', 'red'],
  'only-source': ['+', 'green'],
};

function LineDiffView({ a, b }: { a: string[]; b: string[] }) {
  const lines = lineDiff(a, b);
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text
          key={i}
          color={l.type === 'add' ? 'green' : l.type === 'del' ? 'red' : 'gray'}
          wrap="truncate"
        >
          {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '} {l.text || ' '}
        </Text>
      ))}
    </Box>
  );
}

export default function ResourceDiff({ res, a, b }: { res: ResourceName; a: DiffProfile; b: DiffProfile }) {
  switch (res) {
    case 'User Memory':
      return <LineDiffView a={a.userMemory} b={b.userMemory} />;
    case 'Agents': {
      const names = [...new Set([...Object.keys(a.agents), ...Object.keys(b.agents)])].sort();
      return (
        <Box flexDirection="column">
          {names.map((n) => {
            if (!a.agents[n])
              return (
                <Text key={n} color="green">
                  + {n} (only in {b.name})
                </Text>
              );
            if (!b.agents[n])
              return (
                <Text key={n} color="red">
                  − {n} (only in {a.name})
                </Text>
              );
            if (a.agents[n].join('\n') === b.agents[n].join('\n'))
              return (
                <Text key={n} color="gray">
                  {' '}
                  {n} (identical)
                </Text>
              );
            return (
              <Box key={n} flexDirection="column" marginTop={1}>
                <Text bold>≠ {n}</Text>
                <Box marginLeft={2} flexDirection="column">
                  <LineDiffView a={a.agents[n]} b={b.agents[n]} />
                </Box>
              </Box>
            );
          })}
        </Box>
      );
    }
    case 'Settings': {
      // Redaction contract: key names and verdicts only, never values.
      return (
        <Box flexDirection="column">
          <Text dimColor>values are never shown — key names only (redaction)</Text>
          {keyDiff(a.settings, b.settings).map(([k, v]) => (
            <Text key={k} color={KEY_MARK[v][1]} wrap="truncate">
              {KEY_MARK[v][0]} {k}
              {v === 'changed' ? '  (value differs — hidden)' : v === 'only-a' ? `  (only in ${a.name})` : v === 'only-b' ? `  (only in ${b.name})` : ''}
            </Text>
          ))}
        </Box>
      );
    }
    case 'MCP': {
      // Inventory only: name/transport/status, never config values.
      const names = [...new Set([...a.mcp.map((s) => s.name), ...b.mcp.map((s) => s.name)])].sort();
      return (
        <Box flexDirection="column">
          <Text dimColor>server inventory only — config values never compared</Text>
          <Text bold>
            {'  '}
            {'server'.padEnd(18)} {a.name.padEnd(22)} {b.name}
          </Text>
          {names.map((n) => {
            const sa = a.mcp.find((s) => s.name === n);
            const sb = b.mcp.find((s) => s.name === n);
            const cell = (s?: (typeof a.mcp)[number]) => (s ? `${s.transport} · ${s.status}` : '—');
            const differs = JSON.stringify(sa ?? null) !== JSON.stringify(sb ?? null);
            return (
              <Text key={n} color={differs ? 'yellow' : 'gray'} wrap="truncate">
                {differs ? '≠' : ' '} {n.padEnd(18)} {cell(sa).padEnd(22)} {cell(sb)}
              </Text>
            );
          })}
        </Box>
      );
    }
    case 'Skills': {
      const names = [...new Set([...a.skills.map((s) => s.name), ...b.skills.map((s) => s.name)])].sort();
      return (
        <Box flexDirection="column">
          {names.map((n) => {
            const ka = a.skills.find((s) => s.name === n);
            const kb = b.skills.find((s) => s.name === n);
            if (!ka)
              return (
                <Text key={n} color="green">
                  + {n} (only in {b.name})
                </Text>
              );
            if (!kb)
              return (
                <Text key={n} color="red">
                  − {n} (only in {a.name})
                </Text>
              );
            if (ka.source !== kb.source)
              return (
                <Text key={n} color="yellow">
                  ≠ {n} (different sources — compared per Profile vs own source)
                </Text>
              );
            const rows = fileDiff(ka.profileFiles, ka.sourceFiles);
            const dirty = rows.some(([, v]) => v !== 'same');
            return (
              <Box key={n} flexDirection="column" marginTop={1}>
                <Text bold color={dirty ? 'yellow' : 'gray'}>
                  {dirty ? '≠' : ' '} {n} <Text dimColor>vs source {ka.source}</Text>
                </Text>
                {rows.map(([p, v]) => (
                  <Text key={p} color={FILE_MARK[v][1]} wrap="truncate">
                    {'  '}
                    {FILE_MARK[v][0]} {p}
                    {v === 'changed' ? '  (source moved on)' : v === 'only-source' ? '  (new at source)' : v === 'only-profile' ? '  (gone at source)' : ''}
                  </Text>
                ))}
              </Box>
            );
          })}
        </Box>
      );
    }
    case 'Launch config': {
      return (
        <Box flexDirection="column">
          {keyDiff(a.launch, b.launch).map(([k, v]) => (
            <Text key={k} color={KEY_MARK[v][1]} wrap="truncate">
              {KEY_MARK[v][0]} {k}
              {v === 'changed' ? (
                <>
                  {'  '}
                  <Text color="red">{a.launch[k]}</Text>
                  <Text dimColor> → </Text>
                  <Text color="green">{b.launch[k]}</Text>
                  {k === 'skipPermissions' ? <Text color="yellow">  ⚠ security-sensitive</Text> : null}
                </>
              ) : v === 'same' ? (
                `  ${a.launch[k]}`
              ) : v === 'only-a' ? (
                `  ${a.launch[k]} (only in ${a.name})`
              ) : (
                `  ${b.launch[k]} (only in ${b.name})`
              )}
            </Text>
          ))}
        </Box>
      );
    }
  }
}
