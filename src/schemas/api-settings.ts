import { z } from 'zod';

export const apiEnvSchema = z.record(z.string(), z.string());

export const apiSettingsSchema = z
  .object({
    env: apiEnvSchema.default({}),
  })
  .strict();

export const profileSettingsApiSchema = z
  .object({
    env: apiEnvSchema.optional(),
  })
  .passthrough();

export type ApiSettings = z.infer<typeof apiSettingsSchema>;
