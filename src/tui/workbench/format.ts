// Shared display formatting for resource lists (bytes + ISO dates).
// Extracted so the Auto Memory view and the bulk-ops view render entry
// metadata identically.

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** ISO 8601 → compact YYYY-MM-DD for a list row. */
export function formatDate(iso: string): string {
  return iso.slice(0, 10);
}
