import { z } from 'zod';

/**
 * Profile export bundle manifest.
 *
 * A bundle is a single portable `.tar.gz` file containing `manifest.json` at the
 * archive root and the verbatim profile file tree under `profile/`. The manifest
 * is the authoritative index of what is in the bundle and how it was produced.
 *
 * Spec: docs/Spec-profile-workbench.md §11.2 Export. Export-only here; the
 * matching import path (§11.2 Import) re-parses this schema on read.
 */

export const bundleStrippedKeyScopeSchema = z.enum(['settings-env', 'mcp-env']);

export const bundleStrippedKeysSchema = z
  .object({
    /** Relative path inside the bundle, e.g. "claude-home/settings.json". */
    file: z.string().min(1),
    scope: bundleStrippedKeyScopeSchema,
    /** MCP server name; only meaningful when scope is "mcp-env". */
    mcpServer: z.string().optional(),
    /** Secret-class env key names whose values were stripped. */
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

export const bundleManifestSchema = z
  .object({
    version: z.literal(1),
    bundleFormat: z.literal('ccps-profile-bundle'),
    /** ccps version that produced the bundle, from package.json. */
    exporterVersion: z.string().min(1),
    exportedAt: z.string().min(1),
    profileName: z.string().min(1),
    includeSecrets: z.boolean(),
    /** True when the profile contained any secret-class values, regardless of
     * whether they were stripped or included. Required by issue #73 ("secrets
     * presence"). Distinct from `secretsStripped`, which is only true in default
     * mode after an actual redaction pass. */
    secretsPresent: z.boolean(),
    /** True when secret-class values were stripped (default mode, non-empty list). */
    secretsStripped: z.boolean(),
    strippedKeys: z.array(bundleStrippedKeysSchema),
    resources: bundleResourceCountsSchema,
    /** MCP server inventory by name. */
    mcpServerNames: z.array(z.string()),
  })
  .strict();

export type BundleManifest = z.infer<typeof bundleManifestSchema>;
export type BundleStrippedKeys = z.infer<typeof bundleStrippedKeysSchema>;
export type BundleResourceCounts = z.infer<typeof bundleResourceCountsSchema>;

/** Total number of stripped secret key names across all audit entries. */
export function countStrippedKeys(entries: BundleStrippedKeys[]): number {
  return entries.reduce((sum, entry) => sum + entry.keys.length, 0);
}
