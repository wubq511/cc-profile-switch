import { z } from 'zod';

import { profileNameSchema } from './config';

export const profileTemplateSchema = z.enum(['coding', 'study', 'work', 'research', 'general', 'blank']);
export const mcpModeSchema = z.enum(['merge', 'strict', 'none']);

export const profileLaunchConfigSchema = z
  .object({
    mcpMode: mcpModeSchema.default('merge'),
    pluginDirs: z.array(z.string().min(1)).default([]),
    disableAutoMemory: z.boolean().default(false),
    skipPermissions: z.boolean().default(true),
    claudeArgs: z.array(z.string()).default([]),
  })
  .strict()
  .default({
    mcpMode: 'merge',
    pluginDirs: [],
    disableAutoMemory: false,
    skipPermissions: true,
    claudeArgs: [],
  });

export const profileConfigSchema = z
  .object({
    name: profileNameSchema,
    description: z.string().default(''),
    template: profileTemplateSchema,
    launch: profileLaunchConfigSchema,
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

export type ProfileConfig = z.infer<typeof profileConfigSchema>;
export type ProfileLaunchConfig = z.infer<typeof profileLaunchConfigSchema>;
