import { Request, Response, NextFunction } from 'express';
import { verifyActorToken } from './verifier';
import { resolveActorContext } from './context';
import { UnauthorizedError } from '../errors/index';

/**
 * Optional X-Actor-Token middleware.
 *
 * - No header → req.actorContext = null (caller gets full tenant-level access)
 * - Valid header → req.actorContext = resolved ActorContext
 * - Invalid header → 401
 *
 * The tenant is responsible for deciding whether to send X-Actor-Token.
 * When absent, the API behaves as if the caller has unrestricted read/write
 * access to all tenant data (admin-level).
 *
 * Must run AFTER authMiddleware (needs req.tenantId).
 */
export function actorTokenMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const raw = req.headers['x-actor-token'];

  if (!raw) {
    req.actorContext = null;
    return next();
  }

  const token = Array.isArray(raw) ? raw[0] : raw;

  if (!req.tenantId) {
    return next(new UnauthorizedError('Cannot verify actor token: tenant not identified'));
  }

  try {
    const claims = verifyActorToken(token!, req.tenantId);
    req.actorContext = resolveActorContext(claims);
    next();
  } catch (err) {
    next(err);
  }
}
