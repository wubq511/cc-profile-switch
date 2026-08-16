import { z } from 'zod';

import { validateProfileName } from '../platform/path';

export const profileNameSchema = z.string().refine(
  (value) => {
    try {
      validateProfileName(value);
      return true;
    } catch {
      return false;
    }
  },
  {
    message: 'Profile name must use only safe characters and cannot be reserved.',
  },
);

// Legacy v1 schema — kept for migration reference
export const appConfigV1Schema = z
  .object({
    version: z.literal(1),
    defaultProfile: profileNameSchema.optional(),
    lastUsedProfile: profileNameSchema.nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

export type AppConfigV1 = z.infer<typeof appConfigV1Schema>;

// Current v2 schema
export const appConfigV2Schema = z
  .object({
    version: z.literal(2),
    defaultProfile: profileNameSchema.optional(),
    lastUsedProfile: profileNameSchema.nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    recovery: z
      .object({
        retentionDays: z
          .union([z.literal(7), z.literal(30), z.literal(90), z.null()])
          .default(30),
      })
      .default({ retentionDays: 30 }),
    workbench: z
      .object({
        editor: z.string().optional(),
        skillsDiscoveryExperimental: z.boolean().default(true),
        language: z.enum(['zh', 'en']).optional(),
      })
      .default({ skillsDiscoveryExperimental: true }),
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigV2Schema>;

// Backward-compatible alias for the current schema
export const appConfigSchema = appConfigV2Schema;
