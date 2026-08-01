import { z } from 'zod';

// Per spec §7.1 "Skill provenance and transactions" (issue #38/#63).
// Only fields with consumers are modeled; the upstream Skills lock file is never consulted.

export const skillModeSchema = z.enum(['copy', 'link']);

export const skillSourceKindSchema = z.enum(['git-remote', 'url', 'local', 'unknown']);

// Enclosing git repository discovered at install time for `local` sources.
// Omitted entirely when no enclosing repo is found (Update disabled with reason).
export const skillRepoInfoSchema = z
  .object({
    root: z.string(),
    remoteUrl: z.string().optional(),
    skillPathInRepo: z.string(),
    ref: z.string().optional(),
  })
  .strict();

export const skillSourceSchema = z
  .object({
    kind: skillSourceKindSchema,
    url: z.string().optional(),
    path: z.string().optional(),
    ref: z.string().optional(),
    skillPath: z.string().optional(),
    repo: skillRepoInfoSchema.optional(),
  })
  .strict();

export const skillAuditSchema = z
  .object({
    state: z.string(),
    provider: z.string().optional(),
    fetchedAt: z.string(),
  })
  .strict();

export const skillProvenanceRecordSchema = z
  .object({
    mode: skillModeSchema,
    source: skillSourceSchema,
    contentHash: z.string(),
    installedAt: z.string(),
    updatedAt: z.string(),
    sourceCheckedAt: z.string().optional(),
    link: z
      .object({
        targetPath: z.string(),
      })
      .strict()
      .optional(),
    audit: skillAuditSchema.optional(),
  })
  .strict();

// Manifest: ccps-owned, at profiles/<name>/skills-provenance.json (outside claude-home).
// Top-level `version` is the manifest format version, owned by the versioned-json framework.
// The skill records are keyed by install directory name in claude-home/skills/<name>.
export const skillsProvenanceManifestSchema = z
  .object({
    version: z.literal(1),
    skills: z.record(z.string(), skillProvenanceRecordSchema),
  })
  .strict();

export type SkillMode = z.infer<typeof skillModeSchema>;
export type SkillSourceKind = z.infer<typeof skillSourceKindSchema>;
export type SkillRepoInfo = z.infer<typeof skillRepoInfoSchema>;
export type SkillSource = z.infer<typeof skillSourceSchema>;
export type SkillAudit = z.infer<typeof skillAuditSchema>;
export type SkillProvenanceRecord = z.infer<typeof skillProvenanceRecordSchema>;
export type SkillsProvenanceManifest = z.infer<typeof skillsProvenanceManifestSchema>;

// Link health is computed live at Inspect and never stored (spec §7.1).
export const linkHealthStateSchema = z.enum(['ok', 'link-missing', 'wrong-target', 'source-missing']);
export type LinkHealthState = z.infer<typeof linkHealthStateSchema>;

// Audit cache view states (spec §7.4): pass / warn / fail / not audited / unavailable / cached-stale.
// `cached-stale` is the computed view when the cached entry is past its 24h TTL or refresh failed.
export const auditViewStateSchema = z.enum([
  'pass',
  'warn',
  'fail',
  'not audited',
  'unavailable',
  'cached-stale',
]);
export type AuditViewState = z.infer<typeof auditViewStateSchema>;

export const auditViewSchema = z
  .object({
    state: auditViewStateSchema,
    provider: z.string().optional(),
    fetchedAt: z.string().optional(),
    stale: z.boolean(),
  })
  .strict();
export type AuditView = z.infer<typeof auditViewSchema>;

// Drift signals derived from contentHash (spec §7.1):
// - `local-drift`: a copy-mode profile tree's live hash differs from recorded (someone edited the copy).
// - `source-updated`: a link-mode source tree's live hash differs from recorded (source changed since install).
export const driftStateSchema = z.enum(['none', 'local-drift', 'source-updated']);
export type DriftState = z.infer<typeof driftStateSchema>;

export const corruptionSignalSchema = z
  .object({
    kind: z.literal('orphan-record'),
    skillName: z.string(),
  })
  .strict();
export type CorruptionSignal = z.infer<typeof corruptionSignalSchema>;

// Reason a mutation is disabled for a record (Update / Diff-vs-source), per spec §7.1 backfill.
export const disabledReasonSchema = z.enum(['no-source', 'no-git-repo']);
export type DisabledReason = z.infer<typeof disabledReasonSchema>;

export const capabilityResultSchema = z
  .object({
    enabled: z.boolean(),
    reason: disabledReasonSchema.optional(),
  })
  .strict();
export type CapabilityResult = z.infer<typeof capabilityResultSchema>;
