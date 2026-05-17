import crypto from 'crypto';
import { config } from '../../config/index';

export interface CustomerTokenPayload {
  sub: string;  // customer_id
  tid: string;  // tenant_id
  iat: number;
  exp: number;
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlEncode(str: string): string {
  return base64url(Buffer.from(str, 'utf8'));
}

function base64urlDecode(str: string): string {
  // Pad to multiple of 4
  const padded = str + '==='.slice(0, (4 - (str.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

const HEADER = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function sign(headerDotBody: string, secret: string): string {
  return base64url(crypto.createHmac('sha256', secret).update(headerDotBody).digest());
}

export function issueCustomerToken(tenantId: string, customerId: string): {
  accessToken: string;
  expiresAt: string;
} {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.CUSTOMER_SESSION_TTL_SECONDS;
  const payload: CustomerTokenPayload = { sub: customerId, tid: tenantId, iat: now, exp };
  const body = base64urlEncode(JSON.stringify(payload));
  const sig = sign(`${HEADER}.${body}`, config.CUSTOMER_SESSION_SECRET);
  return {
    accessToken: `${HEADER}.${body}.${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function verifyCustomerToken(token: string): CustomerTokenPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed_token');

  const [header, body, sig] = parts as [string, string, string];
  const expected = sign(`${header}.${body}`, config.CUSTOMER_SESSION_SECRET);

  // Constant-time comparison to prevent timing attacks
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('invalid_signature');
  }

  let payload: CustomerTokenPayload;
  try {
    payload = JSON.parse(base64urlDecode(body));
  } catch {
    throw new Error('malformed_payload');
  }

  if (!payload.sub || !payload.tid || !payload.exp) throw new Error('missing_claims');
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('token_expired');

  return payload;
}
