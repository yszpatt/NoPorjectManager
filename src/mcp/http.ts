import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createApp } from '../app.ts';
import { createPmServer } from './server.ts';

const PORT = Number(process.env.PM_HTTP_PORT ?? 8931);
const PATH = process.env.PM_HTTP_PATH ?? '/mcp';

const app = createApp();

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, mcp-protocol-version, authorization');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return undefined;
  return JSON.parse(raw) as unknown;
}

const server = http.createServer((req, res) => {
  void handle(req, res);
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  cors(res);
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'project-manager',
        transport: 'streamable-http',
        endpoint: PATH,
        dataDir: app.store.paths.dataDir,
        projects: app.projects.list({ include_archived: true }).length,
      }),
    );
    return;
  }

  if (url.pathname !== PATH) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', mcp_endpoint: PATH }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: '无状态模式下仅支持 POST' },
        id: null,
      }),
    );
    return;
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
}

server.listen(PORT, () => {
  console.error(
    `[project-manager] MCP(HTTP) 已启动: http://localhost:${PORT}${PATH}\n` +
      `  数据目录: ${app.store.paths.dataDir}\n` +
      `  健康检查: http://localhost:${PORT}/health`,
  );
});
