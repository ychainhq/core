import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { UnauthorizedError } from '../errors/index';

export interface RawActorClaims {
  sub: string;
  tenant_id: string;
  permissions?: string[];
  roles?: string[];
  teams?: string[];
  exp: number;
  iat: number;
  jti?: string;
}

function base64urlDecode(str: string): string {
  const padded = str + '==='.slice(0, (4 - (str.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function sign(headerDotBody: string, secret: string): string {
  return base64url(crypto.createHmac('sha256', secret).update(headerDotBody).digest());
}

function getTenantActorSecret(tenantId: string): string {
  const db = getDb();
  const row = db
    .prepare('SELECT actor_token_secret FROM tenant_configs WHERE tenant_id = ?')
    .get(tenantId) as { actor_token_secret: string | null } | undefined;

  if (!row?.actor_token_secret) {
    throw new UnauthorizedError('Actor token signing not configured for this tenant');
  }
  return row.actor_token_secret;
}

export function verifyActorToken(token: string, tenantId: string): RawActorClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new UnauthorizedError('Malformed actor token');

  const [header, body, sig] = parts as [string, string, string];

  const secret = getTenantActorSecret(tenantId);
  const expected = sign(`${header}.${body}`, secret);

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new UnauthorizedError('Invalid actor token signature');
  }

  let claims: RawActorClaims;
  try {
    claims = JSON.parse(base64urlDecode(body)) as RawActorClaims;
  } catch {
    throw new UnauthorizedError('Malformed actor token payload');
  }

  if (!claims.sub || !claims.tenant_id || !claims.exp || !claims.iat) {
    throw new UnauthorizedError('Missing required actor token claims');
  }

  if (claims.tenant_id !== tenantId) {
    throw new UnauthorizedError('Actor token tenant mismatch');
  }

  if (claims.exp < Math.floor(Date.now() / 1000)) {
    throw new UnauthorizedError('Actor token expired');
  }

  return claims;
}
