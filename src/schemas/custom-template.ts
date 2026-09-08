import { z } from 'zod';

import { bundleStrippedKeysSchema } from './profile-bundle';

/**
 * Custom profile template manifest (`templates/<name>/template.json`).
 *
 * A custom template is a resource-selected profile tree saved at app-home
 * `templates/<name>/` (spec §11.3, issue #75). Secrets are never stored —
 * env and MCP header values are redacted at save time and `strippedKeys`
 * records the key names for guided re-entry on create (import parity).
 * There is no include-secrets opt-in for templates.
 *
 * Version history:
 *   - v1 (issue #75): settings-env / mcp-env stripped-key scopes only.
 *   - v2 (issue #105): mcp-headers scope exists; readers accept v1 and v2
 *     and reject anything newer; historical artifacts are never rewritten.
 */

export const CUSTOM_TEMPLATE_MANIFEST_VERSION = 2 as const;

export const customTemplateManifestV2Schema = z
  .object({
    version: z.literal(2),
    /** Template name; also the `templates/<name>/` directory name. */
    name: z.string().min(1),
    /** Carried over from the source profile's description, when present. */
    description: z.string().optional(),
    /** Profile the template was saved from. */
    sourceProfile: z.string().min(1),
    createdAt: z.string().min(1),
    /** Secret-class key names whose values were stripped at save time. */
    strippedKeys: z.array(bundleStrippedKeysSchema),
    /** MCP server inventory by name. */
    mcpServerNames: z.array(z.string()),
    /** Linked Skill entries kept as references (never materialized). */
    linkedSkills: z.array(z.string()),
    /** Top-level claude-home entries the resource policy excluded at save time. */
    excludedTopLevelEntries: z.array(z.string()),
  })
  .strict();

export const customTemplateManifestV1Schema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1),
    description: z.string().optional(),
    sourceProfile: z.string().min(1),
    createdAt: z.string().min(1),
    strippedKeys: z.array(bundleStrippedKeysSchema),
    mcpServerNames: z.array(z.string()),
  })
  .strict();

export const customTemplateManifestSchema = z.union([
  customTemplateManifestV2Schema,
  customTemplateManifestV1Schema,
]);

/** Alias for readers that want the union under the versioned name. */
export const customTemplateV2OrV1Schema = customTemplateManifestSchema;

export type CustomTemplateManifestV1 = z.infer<typeof customTemplateManifestV1Schema>;
export type CustomTemplateManifestV2 = z.infer<typeof customTemplateManifestV2Schema>;
export type CustomTemplateManifest = z.infer<typeof customTemplateManifestSchema>;
