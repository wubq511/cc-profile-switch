import { z } from 'zod';

import { profileNameSchema } from './config';

// ─── Recovery Item origin ───────────────────────────────────────────────
// "remove" follows the global retention setting; "update" has a fixed 3-day TTL.
export const recoveryItemOriginSchema = z.enum(['remove', 'update']);
export type RecoveryItemOrigin = z.infer<typeof recoveryItemOriginSchema>;

// ─── Recovery Item shape ────────────────────────────────────────────────
// file-tree: payload is a subdirectory alongside item.json
// fragment: value is stored inside coordinates (file + keyPath + value)
export const recoveryItemShapeSchema = z.enum(['file-tree', 'fragment']);
export type RecoveryItemShape = z.infer<typeof recoveryItemShapeSchema>;

// ─── Recovery Item kind ─────────────────────────────────────────────────
// The resource category that was removed.
export const recoveryItemKindSchema = z.enum([
  'profile',
  'skill',
  'agent',
  'user-memory',
  'auto-memory',
  'mcp-server',
  'settings-field',
  'plugin',
]);
export type RecoveryItemKind = z.infer<typeof recoveryItemKindSchema>;

// ─── Coordinates ────────────────────────────────────────────────────────
// File-tree items carry a targetRelativePath pointing at the payload directory.
// Fragment items carry file + keyPath + value for write-back on restore.
export const fileTreeCoordinatesSchema = z
  .object({
    targetRelativePath: z.string().min(1),
  })
  .strict();

export const fragmentCoordinatesSchema = z
  .object({
    file: z.string().min(1),
    keyPath: z.string().min(1),
    value: z.unknown(),
  })
  .strict();

export type FileTreeCoordinates = z.infer<typeof fileTreeCoordinatesSchema>;
export type FragmentCoordinates = z.infer<typeof fragmentCoordinatesSchema>;

// ─── item.json v1 schema ────────────────────────────────────────────────
export const recoveryItemSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    origin: recoveryItemOriginSchema,
    kind: recoveryItemKindSchema,
    shape: recoveryItemShapeSchema,
    profile: profileNameSchema,
    coordinates: z.union([fileTreeCoordinatesSchema, fragmentCoordinatesSchema]),
    removedAt: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    secretBearing: z.boolean(),
  })
  .strict();

export type RecoveryItem = z.infer<typeof recoveryItemSchema>;

// ─── Retention setting ──────────────────────────────────────────────────
// 7 | 30 | 90 days, or null (Never). Default 30.
export const retentionDaysSchema = z.union([z.literal(7), z.literal(30), z.literal(90), z.null()]);

// ─── Fixed TTL for update-origin items (spec §7.1) ──────────────────────
export const UPDATE_ORIGIN_TTL_DAYS = 3;
