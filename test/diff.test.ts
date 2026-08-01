import { describe, expect, it } from 'vitest';

import {
  diffSettings,
  diffLaunchConfig,
  flattenToKeyPaths,
  keyDiff,
  lineDiff,
  countChanges,
  fileDiff,
  getNestedValue,
  setNestedValue,
  deleteNestedValue,
  verdictSymbol,
} from '../src/core/diff';

describe('diff utilities', () => {
  describe('lineDiff', () => {
    it('produces a classic LCS line diff', () => {
      const result = lineDiff(['a', 'b', 'c'], ['a', 'x', 'c']);
      expect(result).toEqual([
        { type: 'same', text: 'a' },
        { type: 'del', text: 'b' },
        { type: 'add', text: 'x' },
        { type: 'same', text: 'c' },
      ]);
    });

    it('reports identical input with no changes', () => {
      const result = lineDiff(['a', 'b'], ['a', 'b']);
      expect(result.every((l) => l.type === 'same')).toBe(true);
      expect(countChanges(result)).toEqual({ add: 0, del: 0 });
    });
  });

  describe('keyDiff', () => {
    it('labels only-a / only-b / changed / same with values never carried', () => {
      const result = keyDiff(
        { model: 'sonnet', base: 'x', onlyInA: 'secret-a' },
        { model: 'opus', base: 'x', onlyInB: 'secret-b' },
      );

      expect(result).toContainEqual({ key: 'model', verdict: 'changed' });
      expect(result).toContainEqual({ key: 'base', verdict: 'same' });
      expect(result).toContainEqual({ key: 'onlyInA', verdict: 'only-a' });
      expect(result).toContainEqual({ key: 'onlyInB', verdict: 'only-b' });
      // The verdict entries carry key + verdict only — never the secret value.
      for (const entry of result) {
        expect(Object.keys(entry)).toEqual(['key', 'verdict']);
      }
    });

    it('sorts keys alphabetically', () => {
      const result = keyDiff({ z: 1, a: 2 }, { a: 2, z: 1 });
      expect(result.map((r) => r.key)).toEqual(['a', 'z']);
    });
  });

  describe('verdictSymbol', () => {
    it('maps verdicts to display symbols', () => {
      expect(verdictSymbol('changed')).toBe('≠');
      expect(verdictSymbol('only-a')).toBe('-');
      expect(verdictSymbol('only-b')).toBe('+');
      expect(verdictSymbol('same')).toBe(' ');
    });
  });

  describe('flattenToKeyPaths', () => {
    it('flattens nested objects into dot paths', () => {
      const flat = flattenToKeyPaths({
        env: { ANTHROPIC_API_KEY: 'secret', CLAUDE_CODE_ATTRIBUTION_HEADER: '0' },
        autoMemoryDirectory: '/x/auto',
      });
      expect(flat).toEqual({
        'env.ANTHROPIC_API_KEY': 'secret',
        'env.CLAUDE_CODE_ATTRIBUTION_HEADER': '0',
        autoMemoryDirectory: '/x/auto',
      });
    });

    it('keeps arrays as leaves', () => {
      const flat = flattenToKeyPaths({ claudeMdExcludes: ['/a', '/b'] });
      expect(flat.claudeMdExcludes).toEqual(['/a', '/b']);
    });
  });

  describe('nested value helpers (clone semantics)', () => {
    it('gets values by dot path', () => {
      const obj = { env: { A: '1', nested: { B: '2' } } };
      expect(getNestedValue(obj, 'env.A')).toBe('1');
      expect(getNestedValue(obj, 'env.nested.B')).toBe('2');
      expect(getNestedValue(obj, 'env.missing')).toBeUndefined();
    });

    it('sets nested values without mutating the input', () => {
      const obj = { env: { A: '1' } };
      const updated = setNestedValue(obj, 'env.A', '2');
      expect(updated).toEqual({ env: { A: '2' } });
      // The original object is unchanged (clone semantics).
      expect(obj).toEqual({ env: { A: '1' } });
    });

    it('creates intermediate objects when setting a new path', () => {
      const updated = setNestedValue({}, 'env.NEW.KEY', 'x');
      expect(updated).toEqual({ env: { NEW: { KEY: 'x' } } });
    });

    it('deletes nested values without mutating the input', () => {
      const obj = { env: { A: '1', B: '2' } };
      const updated = deleteNestedValue(obj, 'env.A');
      expect(updated).toEqual({ env: { B: '2' } });
      expect(obj).toEqual({ env: { A: '1', B: '2' } });
    });
  });

  describe('diffSettings', () => {
    it('diffs nested settings with key paths and verdicts only', () => {
      const a = {
        env: { ANTHROPIC_API_KEY: 'secret-a', CLAUDE_CODE_ATTRIBUTION_HEADER: '0' },
        model: 'sonnet',
        onlyInA: true,
      };
      const b = {
        env: { ANTHROPIC_API_KEY: 'secret-b', CLAUDE_CODE_ATTRIBUTION_HEADER: '0' },
        model: 'opus',
        onlyInB: true,
      };

      const result = diffSettings(a, b);

      expect(result).toContainEqual({ key: 'env.ANTHROPIC_API_KEY', verdict: 'changed' });
      expect(result).toContainEqual({ key: 'model', verdict: 'changed' });
      expect(result).toContainEqual({ key: 'onlyInA', verdict: 'only-a' });
      expect(result).toContainEqual({ key: 'onlyInB', verdict: 'only-b' });
      expect(result).toContainEqual({ key: 'env.CLAUDE_CODE_ATTRIBUTION_HEADER', verdict: 'same' });
      // No entry carries a value — redaction contract.
      for (const entry of result) {
        expect(Object.keys(entry)).toEqual(['key', 'verdict']);
      }
    });
  });

  describe('diffLaunchConfig', () => {
    it('shows values and flags sensitive fields when changed', () => {
      const a = { mcpMode: 'none', skipPermissions: false, claudeArgs: ['--model', 'sonnet'] };
      const b = { mcpMode: 'none', skipPermissions: true, claudeArgs: ['--model', 'opus'] };

      const result = diffLaunchConfig(a, b);

      const skipRow = result.find((r) => r.key === 'skipPermissions');
      expect(skipRow).toEqual({
        key: 'skipPermissions',
        verdict: 'changed',
        valueA: false,
        valueB: true,
        sensitive: true,
      });

      const mcpRow = result.find((r) => r.key === 'mcpMode');
      expect(mcpRow).toMatchObject({ verdict: 'same', sensitive: false });

      // Values ARE carried for launch config (not secret-class).
      const argsRow = result.find((r) => r.key === 'claudeArgs');
      expect(argsRow?.valueA).toEqual(['--model', 'sonnet']);
      expect(argsRow?.valueB).toEqual(['--model', 'opus']);
      expect(argsRow?.sensitive).toBe(true);
    });

    it('does not flag a sensitive field when unchanged', () => {
      const result = diffLaunchConfig(
        { skipPermissions: true },
        { skipPermissions: true },
      );
      expect(result[0]).toMatchObject({ key: 'skipPermissions', verdict: 'same', sensitive: false });
    });

    it('marks only-present keys', () => {
      const result = diffLaunchConfig({ a: 1 }, { b: 2 });
      expect(result).toContainEqual(
        expect.objectContaining({ key: 'a', verdict: 'only-a', valueA: 1 }),
      );
      expect(result).toContainEqual(
        expect.objectContaining({ key: 'b', verdict: 'only-b', valueB: 2 }),
      );
    });

    it('flags a sensitive field on add/remove, not just change', () => {
      // skipPermissions absent in A (only in B): an add is still a change.
      const onlyB = diffLaunchConfig({}, { skipPermissions: true });
      expect(onlyB.find((r) => r.key === 'skipPermissions')).toMatchObject({
        verdict: 'only-b',
        sensitive: true,
      });

      const onlyA = diffLaunchConfig({ skipPermissions: false }, {});
      expect(onlyA.find((r) => r.key === 'skipPermissions')).toMatchObject({
        verdict: 'only-a',
        sensitive: true,
      });
    });
  });

  describe('fileDiff', () => {
    it('labels profile-only / source-only / changed / same', () => {
      const result = fileDiff(
        [{ path: 'SKILL.md', hash: 'h1' }, { path: 'only.md', hash: 'h2' }],
        [{ path: 'SKILL.md', hash: 'h3' }, { path: 'at-source.md', hash: 'h4' }],
      );

      expect(result).toContainEqual({ path: 'SKILL.md', verdict: 'changed' });
      expect(result).toContainEqual({ path: 'only.md', verdict: 'only-profile' });
      expect(result).toContainEqual({ path: 'at-source.md', verdict: 'only-source' });
    });
  });
});
