import { z } from 'zod';

import { bundleStrippedKeysSchema } from './profile-bundle';

/**
 * Custom profile template manifest (`templates/<name>/template.json`).
 *
 * A custom template is a stripped profile tree saved at app-home
 * `templates/<name>/` (spec §11.3, issue #75). Secrets are never stored —
 * values were redacted at save time and `strippedKeys` records the key names
 * for guided re-entry on create (import parity). There is no include-secrets
 * opt-in for templates.
 */
export const customTemplateManifestSchema = z
  .object({
    version: z.literal(1),
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
  })
  .strict();

export type CustomTemplateManifest = z.infer<typeof customTemplateManifestSchema>;
