import { z } from 'zod';

export const appStateV1Schema = z
  .object({
    version: z.literal(1),
    recentProjectDirs: z
      .array(
        z.object({
          path: z.string(),
          lastUsedAt: z.string(),
        }),
      )
      .max(10),
  })
  .strict();

export type AppState = z.infer<typeof appStateV1Schema>;
