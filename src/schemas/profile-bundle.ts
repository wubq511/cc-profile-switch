import { z } from 'zod';

/**
 * Profile export bundle manifest.
 *
 * A bundle is a single portable `.tar.gz` file containing `manifest.json` at the
 * archive root and the resource-selected profile tree under `profile/`. The
 * manifest is the authoritative index of what is in the bundle and how it was
 * produced.
 *
 * Spec: docs/Spec-profile-workbench.md §11.2 Export; issue #105 (v2).
 *
 * Version history:
 *   - v1 (issue #73): settings-env / mcp-env stripped-key scopes only.
 *   - v2 (issue #105): adds the `mcp-headers` scope for MCP HTTP header
 *     values (redacted under the same rules as env values) and is the
 *     version written by current exporters. Readers accept v1 and v2 and
 *     reject anything newer; historical artifacts are never rewritten.
 */

export const BUNDLE_MANIFEST_VERSION = 2 as const;

export const bundleStrippedKeyScopeSchema = z.enum(['settings-env', 'mcp-env', 'mcp-headers']);

export const bundleStrippedKeysSchema = z
  .object({
    /** Relative path inside the bundle, e.g. "claude-home/settings.json". */
    file: z.string().min(1),
    scope: bundleStrippedKeyScopeSchema,
    /** MCP server name; meaningful when scope is "mcp-env" or "mcp-headers". */
    mcpServer: z.string().optional(),
    /** Secret-class env/header key names whose values were stripped. */
    keys: z.array(z.string()),
  })
  .strict();

export const bundleResourceCountsSchema = z
  .object({
    userMemory: z.number().int().nonnegative(),
    autoMemory: z.number().int().nonnegative(),
    skills: z.number().int().nonnegative(),
    agents: z.number().int().nonnegative(),
    mcpServers: z.number().int().nonnegative(),
    settings: z.number().int().nonnegative(),
    launchConfig: z.number().int().nonnegative(),
  })
  .strict();

/** Manifest fields added in v2. v1 manifests lack them and stay readable. */
const bundleManifestV2FieldsSchema = z
  .object({
    /** Top-level claude-home entries the resource policy excluded. */
    excludedTopLevelEntries: z.array(z.string()),
    /** Top-level claude-home entries copied into the bundle. */
    topLevelEntries: z.array(z.string()),
  })
  .strict();

export const bundleManifestV2Schema = z
  .object({
    version: z.literal(2),
    bundleFormat: z.literal('ccps-profile-bundle'),
    /** ccps version that produced the bundle, from package.json. */
    exporterVersion: z.string().min(1),
    exportedAt: z.string().min(1),
    profileName: z.string().min(1),
    includeSecrets: z.boolean(),
    /** True when the profile contained any secret-class values, regardless of
     * whether they were stripped or included. Distinct from `secretsStripped`,
     * which is only true in default mode after an actual redaction pass. */
    secretsPresent: z.boolean(),
    /** True when secret-class values were stripped (default mode, non-empty list). */
    secretsStripped: z.boolean(),
    strippedKeys: z.array(bundleStrippedKeysSchema),
    resources: bundleResourceCountsSchema,
    /** MCP server inventory by name. */
    mcpServerNames: z.array(z.string()),
  })
  .merge(bundleManifestV2FieldsSchema)
  .strict();

export const bundleManifestV1Schema = z
  .object({
    version: z.literal(1),
    bundleFormat: z.literal('ccps-profile-bundle'),
    exporterVersion: z.string().min(1),
    exportedAt: z.string().min(1),
    profileName: z.string().min(1),
    includeSecrets: z.boolean(),
    secretsPresent: z.boolean(),
    secretsStripped: z.boolean(),
    strippedKeys: z.array(bundleStrippedKeysSchema),
    resources: bundleResourceCountsSchema,
    mcpServerNames: z.array(z.string()),
  })
  .strict();

export const bundleManifestSchema = z.union([bundleManifestV2Schema, bundleManifestV1Schema]);

export type BundleManifestV1 = z.infer<typeof bundleManifestV1Schema>;
export type BundleManifestV2 = z.infer<typeof bundleManifestV2Schema>;
export type BundleManifest = z.infer<typeof bundleManifestSchema>;
export type BundleStrippedKeys = z.infer<typeof bundleStrippedKeysSchema>;
export type BundleResourceCounts = z.infer<typeof bundleResourceCountsSchema>;

/** Total number of stripped secret key names across all audit entries. */
export function countStrippedKeys(entries: BundleStrippedKeys[]): number {
  return entries.reduce((sum, entry) => sum + entry.keys.length, 0);
}

/**
 * Parse a bundle manifest of any supported version (v1, v2) and reject
 * anything newer. The future-version guard runs first so the error names the
 * version; the union parse then validates the shape. Historical artifacts are
 * never rewritten — they are read as-is by their own schema.
 */
export function parseBundleManifest(raw: unknown): BundleManifest {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    !Array.isArray(raw) &&
    'version' in raw &&
    typeof (raw as { version?: unknown }).version === 'number' &&
    (raw as { version: number }).version > BUNDLE_MANIFEST_VERSION
  ) {
    throw new Error(
      `Bundle manifest version ${(raw as { version: number }).version} is newer than supported version ${BUNDLE_MANIFEST_VERSION}.`,
    );
  }
  return bundleManifestSchema.parse(raw);
}
