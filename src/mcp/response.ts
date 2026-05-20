import type { CallToolResult, ReadResourceResult, GetPromptResult } from '@modelcontextprotocol/sdk/types.js';

export function jsonToolResult(data: unknown): CallToolResult {
  const structuredContent = isRecord(data) ? data : { data };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

export function jsonErrorResult(error: { code: string; message: string; details?: unknown }): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error }, null, 2) }],
    structuredContent: { error },
  };
}

export function jsonResource(uri: string, data: unknown): ReadResourceResult {
  return {
    contents: [{
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(isRecord(data) ? data : { data }, null, 2),
    }],
  };
}

export function textPrompt(description: string): GetPromptResult {
  return {
    messages: [{
      role: 'user',
      content: { type: 'text', text: description },
    }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

