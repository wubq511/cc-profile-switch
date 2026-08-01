// PROTOTYPE (throwaway) — Variant B: "One change grammar".
// Every resource diff is flattened into a single changeset: uniform
// +/−/≠ entries across all six resources, one scroll, whole-Profile diff as
// the default unit. Text diffs collapse to "+n −m" summaries; Enter expands
// the underlying line diff inline. Counterpart switching is [←/→].
import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PROFILES, type DiffProfile } from './data';
import { lineDiff, keyDiff, fileDiff, countChanges } from './diffUtil';

interface Entry {
  id: string;
  resource: string;
  mark: '+' | '−' | '≠';
  subject: string; // what changed — key name, file path, server name. Never a value.
  detail?: string; // short qualifier
  lines?: string[]; // expandable: pre-rendered line-diff rows ("+ ..." / "− ...")
}

function buildEntries(a: DiffProfile, b: DiffProfile): Entry[] {
  const out: Entry[] = [];

  const um = lineDiff(a.userMemory, b.userMemory);
  const c = countChanges(um);
  if (c.add || c.del) {
    out.push({
      id: 'um',
      resource: 'User Memory',
      mark: '≠',
      subject: 'CLAUDE.md',
      detail: `+${c.add} −${c.del}`,
      lines: um.filter((l) => l.type !== 'same').map((l) => `${l.type === 'add' ? '+' : '−'} ${l.text}`),
    });
  }

  const agentNames = [...new Set([...Object.keys(a.agents), ...Object.keys(b.agents)])].sort();
  for (const n of agentNames) {
    if (!a.agents[n]) out.push({ id: `ag:${n}`, resource: 'Agents', mark: '+', subject: n, detail: `only in ${b.name}` });
    else if (!b.agents[n]) out.push({ id: `ag:${n}`, resource: 'Agents', mark: '−', subject: n, detail: `only in ${a.name}` });
    else {
      const d = lineDiff(a.agents[n], b.agents[n]);
      const cc = countChanges(d);
      if (cc.add || cc.del)
        out.push({
          id: `ag:${n}`,
          resource: 'Agents',
          mark: '≠',
          subject: n,
          detail: `+${cc.add} −${cc.del}`,
          lines: d.filter((l) => l.type !== 'same').map((l) => `${l.type === 'add' ? '+' : '−'} ${l.text}`),
        });
    }
  }

  for (const [k, v] of keyDiff(a.settings, b.settings)) {
    if (v === 'same') continue;
    out.push({
      id: `se:${k}`,
      resource: 'Settings',
      mark: v === 'changed' ? '≠' : v === 'only-a' ? '−' : '+',
      subject: k,
      detail: v === 'changed' ? 'value differs (hidden)' : v === 'only-a' ? `only in ${a.name}` : `only in ${b.name}`,
    });
  }

  const mcpNames = [...new Set([...a.mcp.map((s) => s.name), ...b.mcp.map((s) => s.name)])].sort();
  for (const n of mcpNames) {
    const sa = a.mcp.find((s) => s.name === n);
    const sb = b.mcp.find((s) => s.name === n);
    if (!sa) out.push({ id: `mc:${n}`, resource: 'MCP', mark: '+', subject: n, detail: `only in ${b.name}` });
    else if (!sb) out.push({ id: `mc:${n}`, resource: 'MCP', mark: '−', subject: n, detail: `only in ${a.name}` });
    else if (sa.transport !== sb.transport || sa.status !== sb.status)
      out.push({ id: `mc:${n}`, resource: 'MCP', mark: '≠', subject: n, detail: `${sa.transport}·${sa.status} → ${sb.transport}·${sb.status}` });
  }

  const skillNames = [...new Set([...a.skills.map((s) => s.name), ...b.skills.map((s) => s.name)])].sort();
  for (const n of skillNames) {
    const ka = a.skills.find((s) => s.name === n);
    const kb = b.skills.find((s) => s.name === n);
    if (!ka) out.push({ id: `sk:${n}`, resource: 'Skills', mark: '+', subject: n, detail: `only in ${b.name}` });
    else if (!kb) out.push({ id: `sk:${n}`, resource: 'Skills', mark: '−', subject: n, detail: `only in ${a.name}` });
    else {
      for (const [p, v] of fileDiff(ka.profileFiles, ka.sourceFiles)) {
        if (v === 'same') continue;
        out.push({
          id: `sk:${n}:${p}`,
          resource: 'Skills',
          mark: v === 'changed' ? '≠' : v === 'only-profile' ? '−' : '+',
          subject: `${n}/${p}`,
          detail: v === 'changed' ? 'source moved on' : v === 'only-source' ? 'new at source' : 'gone at source',
        });
      }
    }
  }

  for (const [k, v] of keyDiff(a.launch, b.launch)) {
    if (v === 'same') continue;
    out.push({
      id: `lc:${k}`,
      resource: 'Launch config',
      mark: v === 'changed' ? '≠' : v === 'only-a' ? '−' : '+',
      subject: k,
      detail:
        v === 'changed'
          ? `${a.launch[k]} → ${b.launch[k]}${k === 'skipPermissions' ? '  ⚠ security-sensitive' : ''}`
          : v === 'only-a'
            ? `${a.launch[k]} (only in ${a.name})`
            : `${b.launch[k]} (only in ${b.name})`,
    });
  }

  return out;
}

const MARK_COLOR = { '+': 'green', '−': 'red', '≠': 'yellow' } as const;

export default function VariantB() {
  const [bi, setBi] = useState(1);
  const [sel, setSel] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const base = PROFILES[0];
  const other = PROFILES[bi];
  const entries = useMemo(() => buildEntries(base, other), [base, other]);

  useInput((input, key) => {
    if (key.leftArrow) {
      setBi((i) => (i - 1 + PROFILES.length) % PROFILES.length || 1);
      setSel(0);
      setOpen(null);
    }
    if (key.rightArrow) {
      setBi((i) => (i + 1) % PROFILES.length || 1);
      setSel(0);
      setOpen(null);
    }
    if (key.upArrow) setSel((i) => Math.max(0, i - 1));
    if (key.downArrow) setSel((i) => Math.min(entries.length - 1, i + 1));
    if (key.return) {
      const e = entries[sel];
      if (e?.lines) setOpen((o) => (o === e.id ? null : e.id));
    }
  });

  let lastResource = '';
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        <Text bold color="cyan">
          Changeset · {base.name} ↔ {other.name}
        </Text>
        <Text dimColor>   {entries.length} changes · [←/→] counterpart</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} marginTop={1} paddingX={1}>
        {entries.length === 0 && <Text dimColor>No differences.</Text>}
        {entries.map((e, i) => {
          const header = e.resource !== lastResource;
          lastResource = e.resource;
          return (
            <Box key={e.id} flexDirection="column">
              {header && (
                <Text bold dimColor>
                  {e.resource}
                </Text>
              )}
              <Text color={MARK_COLOR[e.mark]} bold={i === sel} wrap="truncate">
                {i === sel ? '▸' : ' '} {e.mark} {e.subject}
                <Text dimColor>
                  {'  '}
                  {e.detail}
                  {e.lines ? (open === e.id ? '  [Enter] collapse' : '  [Enter] expand') : ''}
                </Text>
              </Text>
              {open === e.id &&
                e.lines?.map((l, j) => (
                  <Text key={j} color={l.startsWith('+') ? 'green' : 'red'} wrap="truncate">
                    {'    '}
                    {l}
                  </Text>
                ))}
            </Box>
          );
        })}
      </Box>
      <Text dimColor>[↑/↓] move · [Enter] expand text diff · [←/→] counterpart</Text>
    </Box>
  );
}
