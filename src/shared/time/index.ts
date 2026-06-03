/**
 * Convert a stored timestamp value to a Unix epoch timestamp (seconds).
 *
 * Accepts three formats:
 *  - number: milliseconds since epoch (BIGINT from PostgreSQL ledger_entries)
 *  - numeric string: "1749225600774" (SQLite TEXT column storing a ms number)
 *  - ISO string: "2026-06-03T04:10:50.774Z" (all other TEXT timestamp columns)
 */
export function toUnixTs(value: string | number): number {
  if (typeof value === 'number') return Math.floor(value / 1000);
  const n = Number(value);
  if (!isNaN(n) && n > 1_000_000_000_000) return Math.floor(n / 1000); // ms numeric string
  return Math.floor(new Date(value).getTime() / 1000);                   // ISO string
}
