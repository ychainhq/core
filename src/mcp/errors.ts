import { ZodError } from 'zod';
import { ApiError } from '../shared/errors/index';
import { jsonErrorResult, jsonToolResult } from './response';

export function mcpErrorResult(err: unknown) {
  if (err instanceof ZodError) {
    return jsonErrorResult({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }

  if (err instanceof ApiError) {
    return jsonErrorResult({
      code: err.code,
      message: err.message,
      details: err.details,
    });
  }

  if (err instanceof Error) {
    return jsonErrorResult({
      code: 'INTERNAL_SERVER_ERROR',
      message: err.message,
    });
  }

  return jsonErrorResult({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error occurred',
  });
}

export async function safeTool<T>(fn: () => Promise<T> | T) {
  try {
    return jsonToolResult(await fn());
  } catch (err) {
    return mcpErrorResult(err);
  }
}
