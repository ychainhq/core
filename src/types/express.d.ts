import 'express';

declare module 'express-serve-static-core' {
  interface Request {
    tenantId?: string;
    apiKeyId?: string;
    apiKeyName?: string;
  }
}
