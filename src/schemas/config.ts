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

export const workbenchConfigSchema = z
  .object({
    editor: z.string().optional(),
    skillsDiscoveryExperimental: z.boolean().optional(),
    language: z.enum(['zh', 'en']).optional(),
  })
  .strict();

export type WorkbenchConfig = z.infer<typeof workbenchConfigSchema>;

export const appConfigSchema = z
  .object({
    version: z.literal(2),
    defaultProfile: profileNameSchema.optional(),
    lastUsedProfile: profileNameSchema.nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    recovery: z
      .object({
        retentionDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.null()]).optional(),
      })
      .strict()
      .optional(),
    workbench: workbenchConfigSchema.optional(),
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigSchema>;
