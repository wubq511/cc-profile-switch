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
    // Per-key use counts for Workbench contextual-hint retirement (issue #76).
    // Additive optional field (spec §13.4): absent in older state.json files,
    // no version bump; pre-#76 files parse with the field missing.
    hintUsage: z.record(z.string(), z.number().int().nonnegative()).optional(),
  })
  .strict();

export type AppState = z.infer<typeof appStateV1Schema>;
