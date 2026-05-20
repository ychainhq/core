import { Request, Response, NextFunction, Express } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './servers';
import { assertAllowedOrigin, resolveMcpContext, McpServerKind } from './context';
import { ApiError } from '../shared/errors/index';
import { logger } from '../shared/logging/index';

export function registerMcpRoutes(app: Express): void {
  app.post('/mcp/tenant', mcpHandler('tenant'));
  app.post('/mcp/customer', mcpHandler('customer'));
  app.post('/mcp/admin', mcpHandler('admin'));

  app.get(['/mcp/tenant', '/mcp/customer', '/mcp/admin'], (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. Use POST for stateless MCP Streamable HTTP.' },
      id: null,
    });
  });
}

function mcpHandler(kind: McpServerKind) {
  return async (req: Request, res: Response, _next: NextFunction) => {
    let server;
    let transport;
    try {
      assertAllowedOrigin(req);
      const ctx = resolveMcpContext(req, kind);
      server = createMcpServer(ctx);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        if (err instanceof ApiError) {
          res.status(err.statusCode).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: err.message, data: { code: err.code, details: err.details } },
            id: null,
          });
        } else {
          const message = err instanceof Error ? err.message : 'Internal server error';
          logger.error('MCP request failed', { kind, message });
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message },
            id: null,
          });
        }
      }
    } finally {
      try {
        await transport?.close();
      } catch {
        // ignore
      }
      try {
        await server?.close();
      } catch {
        // ignore
      }
    }
  };
}

