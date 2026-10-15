import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { App } from '../app.ts';
import { createPmServer } from './server.ts';

/** MCP 端点路径。与看板 REST API 同端口共用，因此不能是 `/` */
export const MCP_PATH = process.env.PM_HTTP_PATH ?? '/mcp';

/**
 * 就绪探针的响应体。
 *
 * 故意只回「服务活着」这一件事：它免认证暴露，不该带上数据目录、项目数
 * 这类内部信息（那些在 `/api/health` 里，走认证）。
 */
export function mcpHealthPayload(): Record<string, unknown> {
  return {
    ok: true,
    service: 'project-manager',
    transport: 'streamable-http',
    endpoint: MCP_PATH,
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return undefined;
  return JSON.parse(raw) as unknown;
}

/**
 * 把请求交给 MCP(Streamable HTTP) 传输处理。
 *
 * 返回 true 表示这个请求归 MCP 管（响应已写出）；返回 false 表示路径不匹配，
 * 调用方可以继续走自己的路由。
 *
 * 只负责「是不是 MCP 请求」这一件事 —— CORS 预检与认证都留在宿主里，
 * 这样看板与 MCP 能真正共用同一端口、同一套凭据。
 */
export async function handleMcpRequest(
  app: App,
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
): Promise<boolean> {
  if (urlPath !== MCP_PATH) return false;
  // 预检交给宿主的 CORS 逻辑统一处理
  if (req.method === 'OPTIONS') return false;

  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: '无状态模式下仅支持 POST' },
        id: null,
      }),
    );
    return true;
  }

  try {
    const body = await readBody(req);
    // 无状态模式：每个请求一套 server + transport，避免会话状态泄漏
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = createPmServer(app);
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: (err as Error).message },
          id: null,
        }),
      );
    }
  }
  return true;
}
