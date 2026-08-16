/**
 * The ccps version, surfaced to the CLI (`--version`) and to bundle manifests
 * as the exporter version. Kept in `core/` so core services can reference it
 * without importing the CLI entry (which would create a core → cli → commands
 * → core cycle).
 *
 * Bump this in lockstep with `package.json` `version` on release.
 */
export const cliVersion = '0.1.0';
