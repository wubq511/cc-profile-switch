/**
 * Minimal YAML frontmatter parser for Agent .md files.
 *
 * Agents use `---`-delimited YAML frontmatter at the top of their Markdown
 * files. The frontmatter is simple key: value pairs (with optional arrays),
 * so a full YAML parser is unnecessary.
 */

export type FrontmatterResult = {
  frontmatter: Record<string, unknown> | null;
  body: string;
  parseError: string | null;
};

const DELIMITER = '---';
const BOM = '\uFEFF';

/**
 * Parse `---`-delimited frontmatter from a Markdown string.
 *
 * Returns `{ frontmatter, body, parseError }`. If the content has no
 * frontmatter delimiters, `frontmatter` is null and `body` is the full
 * content. Parse failures set `parseError` and leave `frontmatter` null.
 */
export function parseFrontmatter(content: string): FrontmatterResult {
  const trimmed = content.startsWith(BOM) ? content.slice(BOM.length) : content;

  if (!trimmed.startsWith(DELIMITER)) {
    return { frontmatter: null, body: content, parseError: null };
  }

  // Find the closing delimiter. It must appear on its own line.
  const afterFirst = trimmed.slice(DELIMITER.length);
  const newlineAfterFirst = afterFirst.indexOf('\n');

  if (newlineAfterFirst === -1) {
    return { frontmatter: null, body: content, parseError: 'Unclosed frontmatter: no newline after opening ---' };
  }

  // Search for closing --- on its own line
  const rest = afterFirst.slice(newlineAfterFirst + 1);
  const closeIndex = findClosingDelimiter(rest);

  if (closeIndex === -1) {
    return { frontmatter: null, body: content, parseError: 'Unclosed frontmatter: no closing --- found' };
  }

  const frontmatterText = rest.slice(0, closeIndex);
  const bodyText = rest.slice(closeIndex + DELIMITER.length).replace(/^\n+/, '');

  try {
    const frontmatter = parseSimpleYaml(frontmatterText);
    return { frontmatter, body: bodyText, parseError: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { frontmatter: null, body: bodyText, parseError: `Frontmatter parse error: ${message}` };
  }
}

/**
 * Serialize frontmatter and body back into a Markdown string.
 */
export function serializeFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  const lines: string[] = [DELIMITER];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${String(item)}`);
      }
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push(DELIMITER);
  if (body) {
    lines.push('');
    lines.push(body);
  }
  return lines.join('\n');
}

/**
 * Find the closing `---` delimiter on its own line.
 * Returns the index in `text` where the delimiter starts, or -1.
 */
function findClosingDelimiter(text: string): number {
  let pos = 0;
  while (pos < text.length) {
    const lineStart = pos;
    const lineEnd = text.indexOf('\n', pos);
    const line = lineEnd === -1 ? text.slice(pos) : text.slice(pos, lineEnd);

    if (line.trim() === DELIMITER) {
      return lineStart;
    }

    pos = lineEnd === -1 ? text.length : lineEnd + 1;
  }
  return -1;
}

/**
 * Minimal YAML parser for simple key: value and key: [list] structures.
 *
 * Handles:
 *   - `key: value` (string values, unquoted)
 *   - `key: true` / `key: false` (booleans)
 *   - `key: 123` (numbers)
 *   - `key:` with indented `- item` list on subsequent lines
 *   - Quoted string values: `key: "value with spaces"`
 *   - Empty values: `key:` → empty string
 *
 * Does NOT handle: nested objects, multiline strings, anchors, etc.
 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Skip blank lines and comments
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      continue;
    }

    // key: value
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) {
      i++;
      continue;
    }

    const key = trimmed.slice(0, colonIndex).trimEnd();
    const valuePart = trimmed.slice(colonIndex + 1).trimStart();

    // Check for inline list: `key: [a, b]`
    if (valuePart.startsWith('[') && valuePart.endsWith(']')) {
      const items = valuePart.slice(1, -1).split(',').map((s) => parseScalar(s.trim()));
      result[key] = items;
      i++;
      continue;
    }

    // Check for indented list on subsequent lines
    if (valuePart === '' || valuePart === '|' || valuePart === '>') {
      const listItems: unknown[] = [];
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        const nextTrimmed = nextLine.trimStart();
        if (nextTrimmed.startsWith('- ') && nextLine.length - nextTrimmed.length >= 2) {
          listItems.push(parseScalar(nextTrimmed.slice(2).trim()));
          i++;
        } else if (nextTrimmed === '') {
          i++;
          break;
        } else {
          break;
        }
      }
      if (listItems.length > 0) {
        result[key] = listItems;
      } else {
        result[key] = '';
      }
      continue;
    }

    // Inline scalar value
    result[key] = parseScalar(valuePart);
    i++;
  }

  return result;
}

function parseScalar(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;

  // Quoted string
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  // Number
  const num = Number(value);
  if (value !== '' && !isNaN(num) && isFinite(num)) {
    return num;
  }

  return value;
}
