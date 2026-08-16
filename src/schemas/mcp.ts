import { z } from 'zod';

// MCP delegation service view models (spec §7.5 + §6.3 MCP row, issue #62).
//
// Unlike skills-provenance, ccps owns NO persisted MCP file — server state lives
// in Claude Code's own `claude-home/.claude.json`, which ccps reads directly
// (redacted) but never writes directly (mutation is delegated to
// `claude mcp add/remove --scope user`). These schemas describe the redacted
// view models returned by the service, not on-disk state.

// Transport kind, derived from a `.claude.json` mcpServers entry shape.
// `unknown` covers entries ccps cannot classify; it never blocks inspection.
export const mcpTransportSchema = z.enum(['stdio', 'sse', 'http', 'unknown']);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

// Connection state, sourced from `claude mcp list` output (names + state only).
// `unknown` is the graceful degradation when `claude` is unavailable, the list
// call fails/times out, or a server line cannot be parsed.
export const mcpConnectionStateSchema = z.enum(['connected', 'failed', 'unknown']);
export type McpConnectionState = z.infer<typeof mcpConnectionStateSchema>;

// Redacted per-server preview (spec §6.3: command/args/env key names only).
// `scope` is always `user` under `CLAUDE_CONFIG_DIR` (the profile's native
// user scope). Env values are never present — only key names.
export const mcpServerPreviewSchema = z
  .object({
    name: z.string().min(1),
    scope: z.literal('user'),
    transport: mcpTransportSchema,
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    envKeyNames: z.array(z.string().min(1)),
  })
  .strict();
export type McpServerPreview = z.infer<typeof mcpServerPreviewSchema>;

// Inspect entry: a preview plus the live connection state.
export const inspectedMcpServerSchema = mcpServerPreviewSchema.extend({
  connection: mcpConnectionStateSchema,
});
export type InspectedMcpServer = z.infer<typeof inspectedMcpServerSchema>;

// Inspect result for a whole profile.
// `legacyMcpActive` reports whether a legacy root `mcp.json` carries configured
// servers under a non-`none` mcpMode (surfaced in Validate, mirrored here so the
// UI can show the amber nudge). `connectionAvailable` is false when the
// `claude mcp list` call could not run (all servers report `connection: unknown`).
export const mcpInspectResultSchema = z
  .object({
    servers: z.array(inspectedMcpServerSchema),
    legacyMcpActive: z.boolean(),
    connectionAvailable: z.boolean(),
  })
  .strict();
export type McpInspectResult = z.infer<typeof mcpInspectResultSchema>;

// Input for add/edit (delegated to `claude mcp add --scope user`).
// stdio requires `command`; sse/http require `url`. `env` values are passed to
// the delegated command (unavoidable handoff — see service comments) and never
// logged or displayed by ccps itself.
export const mcpAddOptionsSchema = z
  .object({
    name: z.string().min(1),
    transport: z.enum(['stdio', 'sse', 'http']),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type McpAddOptions = z.infer<typeof mcpAddOptionsSchema>;

// Diff result: inventory comparison only (name/transport/connection verdicts).
// Config values (command/args/env) are NEVER compared or present here.
export const mcpDiffEntrySchema = z
  .object({
    name: z.string().min(1),
    transportVerdict: z.enum(['same', 'different']),
    connectionVerdict: z.enum(['same', 'different']),
  })
  .strict();
export type McpDiffEntry = z.infer<typeof mcpDiffEntrySchema>;

export const mcpDiffResultSchema = z
  .object({
    onlyInA: z.array(z.string().min(1)),
    onlyInB: z.array(z.string().min(1)),
    inBoth: z.array(mcpDiffEntrySchema),
  })
  .strict();
export type McpDiffResult = z.infer<typeof mcpDiffResultSchema>;

// Cross-Profile copy result: the non-secret fields were written to the target
// profile via delegation; `strippedEnvKeys` lists the secret env key names the
// caller must prompt the user to re-enter (secret-in-memory rule, spec §6.5).
export const mcpCopyResultSchema = z
  .object({
    copiedName: z.string().min(1),
    strippedEnvKeys: z.array(z.string().min(1)),
  })
  .strict();
export type McpCopyResult = z.infer<typeof mcpCopyResultSchema>;
