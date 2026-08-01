// Shared credential-shape helpers for the fixture tests (issue #77).
//
// Used by both the generator test (asserting generated fixtures contain no real
// credential shapes) and the repo credential-insulation test (asserting no
// tracked file contains real credential shapes). Real credential shapes are
// assembled from fragments so this file does not itself contain a real-shape
// literal that the insulation scan would flag. Each pattern requires a
// high-entropy tail so synthetic placeholders (fixture-placeholder-...,
// sk-ant-REDACTED-a) never match.

export const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // Anthropic API keys (sk-ant-api03-... and long sk-ant-... forms).
  new RegExp('sk-ant-' + 'api03-' + '[A-Za-z0-9_-]{20,}'),
  new RegExp('sk-ant-' + '[A-Za-z0-9_-]{30,}'),
  // Generic high-entropy secret prefix (sk-... without the ant infix, 40+ chars).
  new RegExp('sk-' + '[A-Za-z0-9_-]{40,}'),
  // GitHub tokens.
  new RegExp('ghp_' + '[A-Za-z0-9]{36}'),
  new RegExp('github_pat_' + '[A-Za-z0-9_]{20,}'),
  // AWS access key IDs.
  new RegExp('AKIA' + '[0-9A-Z]{16}'),
  // Slack tokens.
  new RegExp('xox' + '[bpoa]-' + '[A-Za-z0-9-]{10,}'),
  // Google API keys (AIza + 35 base64-ish chars).
  new RegExp('AIza' + '[0-9A-Za-z_-]{35}'),
  // JWTs (eyJ header . eyJ payload . signature).
  new RegExp(
    'eyJ' + '[A-Za-z0-9_-]{10,}\\.' + 'eyJ' + '[A-Za-z0-9_-]{10,}\\.' + '[A-Za-z0-9_-]{10,}',
  ),
];

export function findCredentialShapes(content: string): { pattern: RegExp; match: string }[] {
  const hits: { pattern: RegExp; match: string }[] = [];
  for (const pattern of CREDENTIAL_PATTERNS) {
    const match = pattern.exec(content);
    if (match) {
      hits.push({ pattern, match: match[0] });
    }
  }
  return hits;
}

export function assertNoRealCredentials(content: string, where: string): void {
  const hits = findCredentialShapes(content);
  if (hits.length > 0) {
    throw new Error(
      `real credential shape(s) found in ${where}:\n` +
        hits.map((h) => `  ${h.pattern} matched "${h.match.slice(0, 24)}..."`).join('\n'),
    );
  }
}
