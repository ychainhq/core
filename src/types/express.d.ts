import 'express';
import { ActorContext } from '../shared/actor-auth/types';

declare module 'express-serve-static-core' {
  interface Request {
    tenantId?: string;
    apiKeyId?: string;
    apiKeyName?: string;
    adminKeyName?: string;
    customerId?: string;
    /**
     * Resolved actor context from X-Actor-Token header.
     * null  → no token present; caller has full tenant-level (admin) access.
     * value → RBAC rules are active; use resolvePermission + buildAccessFilter.
     */
    actorContext?: ActorContext | null;
  }
}
