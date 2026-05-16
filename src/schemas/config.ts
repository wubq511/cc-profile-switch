import { z } from 'zod';

import { validateProfileName } from '../platform/windows-path';

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

export const appConfigSchema = z
  .object({
    version: z.literal(1),
    defaultProfile: profileNameSchema.optional(),
    lastUsedProfile: profileNameSchema.nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigSchema>;
