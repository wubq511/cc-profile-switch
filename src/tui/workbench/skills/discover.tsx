import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';

import { useI18n } from '../i18n/react';
import type { LocaleKey } from '../i18n/en';
import type { AuditView } from '../../../schemas/skills-provenance';
import {
  SkillsDiscoverySession,
  type DiscoveredSkill,
  type DiscoveryCatalog,
  type LayerStatus,
} from '../../../core/skills-discovery';

// Discover surface (spec §7.4, issue #68).
//
// The three-tier Skills discovery floor in the Workbench:
//   - curated GitHub backbone browse (zero query) + merged search (backbone
//     search + skills.sh experimental layer when enabled);
//   - source entry (`s`) and browser handoff (`b` opens skills.sh so a pasted
//     source installs through the §7.3 adapter);
//   - per-result audit states (six states; absence is `not audited`, never safe),
//     install counts/trending when available, fetch timestamps, and honest
//     "catalog unavailable" wording for a failed layer — never "no results".

export type DiscoverViewProps = {
  profileName: string;
  session: SkillsDiscoverySession;
  width: number;
  height: number;
  headless?: boolean;
  onBack: () => void;
  /** Install a discovered source through the acquisition adapter (wizard). */
  onInstallSource: (source: string, skill?: string) => void;
  /** Browser handoff — opens skills.sh so the user can paste a source back. */
  onOpenBrowser: (url: string) => void;
};

type Mode = 'results' | 'source';

const SKILLSHUB_URL = 'https://skills.sh';
const SEARCH_DEBOUNCE_MS = 250;

export function DiscoverView({
  profileName,
  session,
  width,
  height,
  headless,
  onBack,
  onInstallSource,
  onOpenBrowser,
}: DiscoverViewProps): React.ReactElement {
  const { t } = useI18n();
  const { stdin: inkStdin } = useStdin();
  const canUseInput = !headless && inkStdin.isTTY === true;

  const [catalog, setCatalog] = useState<DiscoveryCatalog | null>(null);
  // Loading starts true: the curated browse is async, so the first frame must
  // say "browsing", never a misleading "No results." (spec §7.4 wording).
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<Mode>('results');
  const [sourceInput, setSourceInput] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard stale async responses: only the latest request may land.
  const requestSeq = useRef(0);

  const loadBrowse = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setCatalog(null);
    try {
      const result = await session.browse();
      if (seq !== requestSeq.current) return;
      setCatalog(result);
      setSelectedIndex(0);
    } catch {
      if (seq !== requestSeq.current) return;
      setCatalog(failureCatalog());
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [session]);

  const runSearch = useCallback(async (rawQuery: string) => {
    const q = rawQuery.trim();
    if (q.length === 0) {
      void loadBrowse();
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    setCatalog(null);
    try {
      const result = await session.search(q);
      if (seq !== requestSeq.current) return;
      setCatalog(result);
      setSelectedIndex(0);
    } catch {
      if (seq !== requestSeq.current) return;
      setCatalog(failureCatalog());
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [session, loadBrowse]);

  const scheduleSearch = useCallback((nextQuery: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runSearch(nextQuery);
    }, SEARCH_DEBOUNCE_MS);
  }, [runSearch]);

  // Load the curated backbone floor on mount.
  useEffect(() => {
    void loadBrowse();
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [loadBrowse]);

  useInput((input: string, key: Record<string, boolean>) => {
    if (key.ctrl && input === 'c') return; // app-level exit handles this

    // Source entry mode (the zero-config floor).
    if (mode === 'source') {
      if (key.escape) {
        setMode('results');
        setSourceInput('');
        return;
      }
      if (key.return) {
        const source = sourceInput.trim();
        setMode('results');
        setSourceInput('');
        if (source.length > 0) onInstallSource(source);
        return;
      }
      if (key.backspace || key.delete) {
        setSourceInput((s) => s.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input.length === 1) {
        setSourceInput((s) => s + input);
      }
      return;
    }

    // Search input.
    if (searchFocused) {
      if (key.escape) {
        setSearchFocused(false);
        setQuery('');
        setStatus(null);
        void loadBrowse();
        return;
      }
      if (key.return) {
        setSearchFocused(false);
        return;
      }
      if (key.backspace || key.delete) {
        const next = query.slice(0, -1);
        setQuery(next);
        setSelectedIndex(0);
        scheduleSearch(next);
        return;
      }
      if (!key.ctrl && !key.meta && input.length === 1) {
        const next = query + input;
        setQuery(next);
        setSelectedIndex(0);
        scheduleSearch(next);
      }
      return;
    }

    // Results mode.
    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow) {
      const count = catalog?.results.length ?? 0;
      setSelectedIndex((i) => (i > 0 ? i - 1 : Math.max(0, count - 1)));
      return;
    }
    if (key.downArrow) {
      const count = catalog?.results.length ?? 0;
      setSelectedIndex((i) => (i < count - 1 ? i + 1 : 0));
      return;
    }
    if (input === '/') {
      setSearchFocused(true);
      setStatus(null);
      return;
    }
    if (key.return) {
      const skill = catalog?.results[selectedIndex];
      if (skill) onInstallSource(skill.installSource, skill.skill);
      return;
    }
    if (input === 's') {
      setMode('source');
      setSourceInput('');
      setStatus(null);
      return;
    }
    if (input === 'b') {
      onOpenBrowser(SKILLSHUB_URL);
      setStatus(t('discover.browser.opened'));
      return;
    }
    if (input === 'r') {
      setStatus(null);
      if (query.trim().length > 0) {
        void runSearch(query);
      } else {
        void loadBrowse();
      }
      return;
    }
  }, { isActive: canUseInput });

  const experimentalEnabled = session.experimentalEnabled;
  const results = catalog?.results ?? [];
  const anyUnavailable = (catalog?.layers ?? []).some((l: LayerStatus) => l.unavailable);
  const listHeight = Math.max(3, height - 8);

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold>{t('discover.breadcrumb')}</Text>
        <Text dimColor> · {profileName}</Text>
        {experimentalEnabled && (
          <Text color="magenta" bold>
            {' '}
            [{t('discover.experimental.badge')}]
          </Text>
        )}
        {!experimentalEnabled && (
          <Text dimColor> ({t('discover.experimental.off')})</Text>
        )}
      </Box>

      {/* Search / source line */}
      {mode === 'source' ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{t('discover.source.prompt')}</Text>
          <Text color="cyan">{sourceInput}█</Text>
          <Text dimColor>{t('discover.source.hint')}</Text>
        </Box>
      ) : searchFocused ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="cyan">/ {query}█</Text>
          <Text dimColor>{t('discover.search.hint')}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>
            {query.trim().length > 0
              ? `${t('discover.search.active')}: ${query}`
              : t('discover.search.placeholder')}
          </Text>
        </Box>
      )}

      {/* Results — a healthy layer's results survive the other's failure
          (§7.4 "each layer covers the other's failure"); the unavailable
          wording only replaces the list when nothing survived. */}
      <Box flexDirection="column" height={listHeight}>
        {loading ? (
          <Text color="yellow">
            {query.trim().length > 0
              ? t('discover.loading.search')
              : t('discover.loading.browse')}
          </Text>
        ) : results.length > 0 ? (
          renderWindow(results, selectedIndex, listHeight, width, t).map((row) => row)
        ) : anyUnavailable ? (
          <Text color="yellow" wrap="wrap">
            {formatLayerNote(catalog!.layers, 'discover.unavailable', t)}
          </Text>
        ) : (
          <Text dimColor>{t('discover.empty')}</Text>
        )}
      </Box>

      {/* Layer status + hint */}
      <Box flexDirection="column" marginTop={1}>
        <StatusLine catalog={catalog} t={t} />
        {status && <Text color="yellow">{status}</Text>}
        {mode !== 'source' && !searchFocused && (
          <Text dimColor>{t('discover.actions')}</Text>
        )}
      </Box>
    </Box>
  );
}

function renderWindow(
  skills: DiscoveredSkill[],
  selectedIndex: number,
  listHeight: number,
  width: number,
  t: (key: LocaleKey) => string,
): React.ReactElement[] {
  const windowSize = Math.max(1, listHeight);
  const start = Math.max(0, selectedIndex - Math.floor(windowSize / 2));
  const end = Math.min(skills.length, start + windowSize);
  const rows: React.ReactElement[] = [];
  for (let i = start; i < end; i++) {
    const skill = skills[i]!;
    const isSel = i === selectedIndex;
    const audit = renderAudit(skill.audit, t);
    const meta = [
      skill.repository,
      audit.label,
      skill.installs !== undefined ? t('discover.installs').replace('{count}', formatCount(skill.installs)) : '',
      skill.trending ? t('discover.trending') : '',
      t('discover.fetchedAt').replace('{time}', formatTime(skill.fetchedAt)),
    ]
      .filter(Boolean)
      .join(' · ');
    const nameLine = `${isSel ? '▸ ' : '  '}${skill.name}`;
    const detailLine =
      skill.description && skill.description.length > 0
        ? `    ${truncate(skill.description, Math.max(20, width - 6))}`
        : null;
    rows.push(
      <Box key={`${skill.id}-${i}`} flexDirection="column">
        <Text bold={isSel} color={isSel ? 'cyan' : undefined} inverse={isSel}>
          {nameLine}
        </Text>
        <Text dimColor wrap="truncate">
          {meta}
        </Text>
        {detailLine && (
          <Text dimColor wrap="truncate">
            {detailLine}
          </Text>
        )}
      </Box>,
    );
  }
  return rows;
}

function StatusLine({
  catalog,
  t,
}: {
  catalog: DiscoveryCatalog | null;
  t: (key: LocaleKey) => string;
}): React.ReactElement | null {
  if (!catalog || catalog.results.length === 0) return null;
  const unavailable = catalog.layers.filter((l: LayerStatus) => l.unavailable);
  const degraded = catalog.layers.filter((l: LayerStatus) => l.state === 'ok' && l.degraded);
  const stale = catalog.layers.filter((l: LayerStatus) => l.stale);

  // A healthy layer's results survived an unavailable one — name it so the
  // wording reads "catalog unavailable", never disguised as "no results".
  if (unavailable.length > 0) {
    return (
      <Text color="yellow" wrap="wrap">
        {formatLayerNote(unavailable, 'discover.unavailable', t)}
      </Text>
    );
  }
  // The layer returned results but some sources failed — surface the partial
  // degradation instead of reading as fully healthy.
  if (degraded.length > 0) {
    return (
      <Text color="yellow" wrap="wrap">
        {formatLayerNote(degraded, 'discover.partial', t)}
      </Text>
    );
  }
  if (stale.length > 0) {
    const fetchedAt = stale[0]!.fetchedAt;
    return (
      <Text dimColor wrap="wrap">
        {t('discover.cachedStale').replace('{time}', fetchedAt ? formatTime(fetchedAt) : '')}
      </Text>
    );
  }
  return null;
}

/** Resolve the "{layers} ({reason})" note and apply it to an i18n template. */
function formatLayerNote(
  layers: LayerStatus[],
  template: 'discover.unavailable' | 'discover.partial',
  t: (key: LocaleKey) => string,
): string {
  const names = layers
    .map((l) => t(`discover.unavailable.layer.${l.layer}` as LocaleKey))
    .join(', ');
  const reasons = [
    ...new Set(
      layers.map((l) =>
        l.state === 'ok'
          ? t(`discover.unavailable.reason.${l.errorCode ?? 'unavailable'}` as LocaleKey)
          : t(`discover.unavailable.reason.${l.state}` as LocaleKey),
      ),
    ),
  ].join(', ');
  return t(template).replace('{layers}', names).replace('{reason}', reasons);
}

/** A catalog that read "catalog unavailable" for an unexpected (non-classified)
 * failure — the results area must never show "No results." for a failed layer. */
function failureCatalog(): DiscoveryCatalog {
  return {
    results: [],
    layers: [{ layer: 'backbone', state: 'unavailable', unavailable: true, errorCode: 'unavailable' }],
    fetchedAt: new Date().toISOString(),
  };
}

// Six-state audit view (spec §7.4): pass / warn / fail / not audited /
// unavailable / cached-stale. Every state carries a glyph + text label — color
// is never the only channel (§14). Absence renders as `not audited`, never safe.
function renderAudit(audit: AuditView, t: (key: LocaleKey) => string): { label: string } {
  switch (audit.state) {
    case 'pass':
      return { label: `✓ ${t('discover.audit.pass')}` };
    case 'warn':
      return { label: `⚠ ${t('discover.audit.warn')}` };
    case 'fail':
      return { label: `✗ ${t('discover.audit.fail')}` };
    case 'unavailable':
      return { label: `? ${t('discover.audit.unavailable')}` };
    case 'cached-stale':
      return { label: `◌ ${t('discover.audit.cachedStale')}` };
    default:
      return { label: `○ ${t('discover.audit.notAudited')}` };
  }
}

function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

function formatTime(iso: string): string {
  // ISO timestamp → compact HH:MM (UTC) for the result row.
  return iso.length >= 16 ? iso.slice(11, 16) : '';
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
