import { describe, expect, it } from 'vitest';

import {
  mapAuditPayload,
  parseSkillshubItem,
  SkillshubClient,
  type DiscoveryHttp,
} from '../src/core/skills-discovery';
import { FakeResponse, skillshubSearch } from './fixtures/discovery-http';

// Experimental skills.sh layer (spec §7.4, issue #68).
//
// Queries the undocumented `GET /api/search` endpoint directly, carries install
// counts and a trending flag when available, and maps audit payloads to the
// six-state audit view — absence is `not audited`, never safe.

const FIXED_NOW = () => new Date('2026-08-01T12:00:00.000Z');

describe('parseSkillshubItem', () => {
  it('parses a GitHub-hosted result with install counts', () => {
    const skill = parseSkillshubItem(
      {
        id: 'github/awesome-copilot/git-commit',
        skillId: 'git-commit',
        name: 'git-commit',
        installs: 41003,
        source: 'github/awesome-copilot',
      },
      '2026-08-01T12:00:00.000Z',
    );
    expect(skill).toMatchObject({
      repository: 'github/awesome-copilot',
      directory: 'git-commit',
      name: 'git-commit',
      installs: 41003,
      layers: ['skillshub'],
      fetchedAt: '2026-08-01T12:00:00.000Z',
      // Install routes through the §7.3 adapter as owner/repo + --skill.
      installSource: 'github/awesome-copilot',
      skill: 'git-commit',
    });
    // No audit payload → `not audited`, never rendered as safe.
    expect(skill!.audit.state).toBe('not audited');
  });

  it('carries a trending flag when available', () => {
    const skill = parseSkillshubItem(
      { id: 'o/r/s', skillId: 's', name: 's', source: 'o/r', trending: true, installs: 5 },
      't0',
    );
    expect(skill!.trending).toBe(true);
  });

  it('derives repository + directory from the id when source/skillId are missing', () => {
    const skill = parseSkillshubItem({ id: 'mattpocock/skills/git-guardrails' }, 't0');
    expect(skill!.repository).toBe('mattpocock/skills');
    expect(skill!.directory).toBe('git-guardrails');
    expect(skill!.installSource).toBe('mattpocock/skills');
    expect(skill!.skill).toBe('git-guardrails');
  });

  it('returns null for a result without a resolvable repository/directory', () => {
    expect(parseSkillshubItem({ name: 'no-id' }, 't0')).toBeNull();
    expect(parseSkillshubItem('not-an-object', 't0')).toBeNull();
  });

  it('maps a string audit payload to the six-state view', () => {
    expect(mapAuditPayload('pass', 't0').state).toBe('pass');
    expect(mapAuditPayload('warn', 't0').state).toBe('warn');
    expect(mapAuditPayload('fail', 't0').state).toBe('fail');
    expect(mapAuditPayload('weird-value', 't0').state).toBe('not audited');
  });

  it('maps an object audit payload including provider and fetchedAt', () => {
    const audit = mapAuditPayload(
      { state: 'fail', provider: 'skills.sh', fetchedAt: '2026-08-01T00:00:00.000Z' },
      't0',
    );
    expect(audit).toEqual({
      state: 'fail',
      provider: 'skills.sh',
      fetchedAt: '2026-08-01T00:00:00.000Z',
      stale: false,
    });
  });

  it('keeps an audit payload parsed from a search result on the Skill', () => {
    const skill = parseSkillshubItem(
      { id: 'o/r/s', skillId: 's', name: 's', source: 'o/r', audit: 'pass' },
      't0',
    );
    expect(skill!.audit.state).toBe('pass');
  });
});

describe('SkillshubClient.search', () => {
  it('queries GET /api/search and parses results', async () => {
    const calls: string[] = [];
    const http: DiscoveryHttp = async (url) => {
      calls.push(url);
      return skillshubSearch([
        { id: 'github/awesome-copilot/git-commit', skillId: 'git-commit', name: 'git-commit', installs: 41003, source: 'github/awesome-copilot' },
      ]);
    };
    const client = new SkillshubClient({ http, now: FIXED_NOW });

    const skills = await client.search('git');
    expect(skills).toHaveLength(1);
    expect(skills[0]!.installs).toBe(41003);
    expect(calls[0]).toContain('https://skills.sh/api/search?q=git');
  });

  it('honors the limit option', async () => {
    const calls: string[] = [];
    const http: DiscoveryHttp = async (url) => {
      calls.push(url);
      return skillshubSearch([]);
    };
    const client = new SkillshubClient({ http, limit: 20 });
    await client.search('git');
    expect(calls[0]).toContain('&limit=20');
  });

  it('returns empty for an empty query without a network call', async () => {
    const calls: string[] = [];
    const http: DiscoveryHttp = async (url) => {
      calls.push(url);
      return skillshubSearch([]);
    };
    const client = new SkillshubClient({ http });
    expect(await client.search('   ')).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('classifies a network failure as offline', async () => {
    const http: DiscoveryHttp = async () => {
      throw new TypeError('fetch failed');
    };
    const client = new SkillshubClient({ http });
    await expect(client.search('git')).rejects.toMatchObject({ kind: 'offline' });
  });

  it('classifies an HTTP error as unavailable (catalog unavailable, never "no results")', async () => {
    const http: DiscoveryHttp = async () => new FakeResponse(500, {});
    const client = new SkillshubClient({ http });
    await expect(client.search('git')).rejects.toMatchObject({ kind: 'unavailable' });
  });
});
