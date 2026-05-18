/**
 * Convert an ISO 8601 string stored in SQLite to a Unix epoch timestamp (seconds).
 * All API responses use Unix timestamps; SQLite internal storage remains ISO strings.
 */
export function toUnixTs(isoString: string): number {
  return Math.floor(new Date(isoString).getTime() / 1000);
}
