import { describe, expect, it } from 'vitest';

import { parseFrontmatter, serializeFrontmatter } from '../src/core/resource/frontmatter';

describe('parseFrontmatter', () => {
  it('parses simple key: value frontmatter', () => {
    const result = parseFrontmatter('---\nname: explore\ndescription: read-only\n---\n\nBody text.\n');
    expect(result.frontmatter).toEqual({ name: 'explore', description: 'read-only' });
    expect(result.body).toBe('Body text.\n');
    expect(result.parseError).toBeNull();
  });

  it('parses typed scalars (boolean, number, null)', () => {
    const result = parseFrontmatter('---\na: true\nb: 42\nc: null\n---\n');
    expect(result.frontmatter).toEqual({ a: true, b: 42, c: null });
  });

  it('parses quoted values', () => {
    const content = '---\ntitle: "hello world"\ndescription: "it\'s fine"\n---\n';
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({ title: 'hello world', description: "it's fine" });
  });

  it('parses indented list values', () => {
    const result = parseFrontmatter('---\ntools:\n  - bash\n  - grep\n---\n');
    expect(result.frontmatter).toEqual({ tools: ['bash', 'grep'] });
  });

  it('parses inline list values', () => {
    const result = parseFrontmatter('---\ntools: [a, b, c]\n---\n');
    expect(result.frontmatter).toEqual({ tools: ['a', 'b', 'c'] });
  });

  it('returns null frontmatter for content without delimiters', () => {
    const result = parseFrontmatter('# Just markdown\nNo frontmatter here.\n');
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe('# Just markdown\nNo frontmatter here.\n');
    expect(result.parseError).toBeNull();
  });

  it('reports unclosed frontmatter as a parse error', () => {
    const result = parseFrontmatter('---\nname: explore\nno closing delimiter\n');
    expect(result.frontmatter).toBeNull();
    expect(result.parseError).not.toBeNull();
  });

  it('handles empty frontmatter', () => {
    const result = parseFrontmatter('---\n---\nBody only.\n');
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('Body only.\n');
  });

  it('treats a lone opening delimiter with no newline as unparsed', () => {
    const result = parseFrontmatter('---');
    expect(result.frontmatter).toBeNull();
    expect(result.parseError).not.toBeNull();
  });
});

describe('serializeFrontmatter', () => {
  it('round-trips frontmatter + body', () => {
    const serialized = serializeFrontmatter(
      { name: 'explore', description: 'read-only' },
      'Body text.',
    );
    expect(serialized).toBe('---\nname: explore\ndescription: read-only\n---\n\nBody text.');

    const parsed = parseFrontmatter(serialized);
    expect(parsed.frontmatter).toEqual({ name: 'explore', description: 'read-only' });
    expect(parsed.body).toBe('Body text.');
  });

  it('serializes array values as indented lists', () => {
    const serialized = serializeFrontmatter({ tools: ['bash', 'grep'] }, '');
    expect(serialized).toBe('---\ntools:\n  - bash\n  - grep\n---');
  });

  it('omits trailing blank line when body is empty', () => {
    const serialized = serializeFrontmatter({ name: 'x' }, '');
    expect(serialized.endsWith('---\n')).toBe(false);
    expect(serialized).toBe('---\nname: x\n---');
  });
});
