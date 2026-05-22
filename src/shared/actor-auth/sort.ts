import crypto from 'crypto';
import { SortPolicy, NormalizedSort, DecodedCursor, EntityDefinition } from './types';
import { UnprocessableEntityError } from '../errors/index';
import { config } from '../../config/index';

// ----------------------------------------------------------------
// SortNormalizer
// ----------------------------------------------------------------

/**
 * Parses a "field:direction" sort string and validates against the entity's
 * allowed sort fields. Falls back to the entity's default sort.
 */
export function normalizeSort(
  raw: string | undefined,
  policy: SortPolicy
): NormalizedSort {
  if (!raw) {
    const def = policy.allowed[policy.default.field];
    if (!def) throw new Error(`Default sort field "${policy.default.field}" not in allowed list`);
    return {
      primary: { physical: def.physical, direction: policy.default.direction },
      tieBreaker: { physical: policy.tieBreaker.physical, direction: policy.tieBreaker.direction },
    };
  }

  const [field, dir] = raw.split(':');
  if (!field) throw new UnprocessableEntityError(`Invalid sort format, use "field:asc" or "field:desc"`);

  const direction: 'asc' | 'desc' = dir === 'asc' ? 'asc' : dir === 'desc' ? 'desc' : 'desc';
  if (dir && dir !== 'asc' && dir !== 'desc') {
    throw new UnprocessableEntityError(`Sort direction must be "asc" or "desc", got "${dir}"`);
  }

  const def = policy.allowed[field];
  if (!def) {
    throw new UnprocessableEntityError(
      `Unsupported sort field "${field}". Allowed: ${Object.keys(policy.allowed).join(', ')}`
    );
  }

  return {
    primary: { physical: def.physical, direction },
    tieBreaker: { physical: policy.tieBreaker.physical, direction: policy.tieBreaker.direction },
  };
}

/** Returns ORDER BY clause for a normalized sort. */
export function sortToOrderBy(sort: NormalizedSort): string {
  return `${sort.primary.physical} ${sort.primary.direction.toUpperCase()}, ${sort.tieBreaker.physical} ${sort.tieBreaker.direction.toUpperCase()}`;
}

/** Returns a hash of the sort string for cursor fingerprinting. */
export function sortHash(sort: NormalizedSort): string {
  const key = `${sort.primary.physical}:${sort.primary.direction}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// ----------------------------------------------------------------
// CursorPolicy
// ----------------------------------------------------------------

const CURSOR_TTL_SECONDS = 86400; // 24 hours
const CURSOR_SEP = '.';

function cursorBase64(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function cursorBase64Decode(str: string): string {
  const padded = str + '==='.slice(0, (4 - (str.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function hmacCursor(payload: string): string {
  return crypto
    .createHmac('sha256', config.CUSTOMER_SESSION_SECRET)
    .update(payload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Encodes the last row of a page into a signed opaque cursor string.
 */
export function encodeCursor(
  lastRow: Record<string, unknown>,
  sort: NormalizedSort,
  tenantId: string,
  actorId: string | null
): string {
  const payload: DecodedCursor = {
    lastValues: {
      [sort.primary.physical]: lastRow[physicalToColumn(sort.primary.physical)],
      [sort.tieBreaker.physical]: lastRow[physicalToColumn(sort.tieBreaker.physical)],
    },
    sortHash: sortHash(sort),
    tenantId,
    actorId,
    expiresAt: Math.floor(Date.now() / 1000) + CURSOR_TTL_SECONDS,
  };

  const encoded = cursorBase64(JSON.stringify(payload));
  const sig = hmacCursor(encoded);
  return `${encoded}${CURSOR_SEP}${sig}`;
}

/**
 * Verifies and decodes a cursor. Throws UnprocessableEntityError if invalid.
 */
export function decodeCursor(
  raw: string,
  sort: NormalizedSort,
  tenantId: string,
  actorId: string | null
): DecodedCursor {
  const sepIdx = raw.lastIndexOf(CURSOR_SEP);
  if (sepIdx === -1) throw new UnprocessableEntityError('Invalid cursor format');

  const encoded = raw.slice(0, sepIdx);
  const sig = raw.slice(sepIdx + 1);

  const expectedSig = hmacCursor(encoded);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new UnprocessableEntityError('Invalid cursor signature');
  }

  let decoded: DecodedCursor;
  try {
    decoded = JSON.parse(cursorBase64Decode(encoded)) as DecodedCursor;
  } catch {
    throw new UnprocessableEntityError('Malformed cursor payload');
  }

  if (decoded.expiresAt < Math.floor(Date.now() / 1000)) {
    throw new UnprocessableEntityError('Cursor expired, please restart pagination');
  }
  if (decoded.tenantId !== tenantId) {
    throw new UnprocessableEntityError('Cursor tenant mismatch');
  }
  if (decoded.actorId !== actorId) {
    throw new UnprocessableEntityError('Cursor actor mismatch');
  }
  if (decoded.sortHash !== sortHash(sort)) {
    throw new UnprocessableEntityError('Cursor sort mismatch — sort changed between pages');
  }

  return decoded;
}

/**
 * Builds the cursor WHERE clause fragment (after "WHERE 1=1 AND access_filter ...").
 * For "col DESC, id ASC" with cursor values (v1, id1):
 *   (col < v1) OR (col = v1 AND id > id1)
 */
export function cursorToSql(cursor: DecodedCursor, sort: NormalizedSort): { sql: string; params: unknown[] } {
  const pf = sort.primary.physical;
  const tf = sort.tieBreaker.physical;
  const pv = cursor.lastValues[pf];
  const tv = cursor.lastValues[tf];

  const pOp = sort.primary.direction === 'desc' ? '<' : '>';
  const tOp = sort.tieBreaker.direction === 'desc' ? '<' : '>';

  return {
    sql: `AND ((${pf} ${pOp} ?) OR (${pf} = ? AND ${tf} ${tOp} ?))`,
    params: [pv, pv, tv],
  };
}

/** Extracts the bare column name from a "alias.column" physical field. */
function physicalToColumn(physical: string): string {
  const dot = physical.indexOf('.');
  return dot === -1 ? physical : physical.slice(dot + 1);
}

// ----------------------------------------------------------------
// EntityDefinition factory helpers
// ----------------------------------------------------------------

export function buildEntityDef(def: EntityDefinition): EntityDefinition {
  return def;
}
