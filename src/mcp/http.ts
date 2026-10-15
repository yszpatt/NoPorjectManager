import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../app.ts';
import { handleMcpRequest, mcpHealthPayload, MCP_PATH } from './http-handler.ts';

const PORT = Number(process.env.PM_HTTP_PORT ?? 8931);

const app = createApp();

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, mcp-protocol-version, authorization');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');
}

const server = http.createServer((req, res) => {
  void handle(req, res);
});

/**
 * 独立运行的 MCP(HTTP) 服务 —— 只有 MCP 端点，没有看板 UI，也没有认证。
 *
 * 日常应该用 `pm serve`：看板、REST API 与 MCP 在同一个端口上，共用同一套凭据。
 * 这个入口留着是为了「只给远端 Agent 开一个 MCP 端口、不给 UI」这类场景，
 * 请只绑回环或放进受控网络。
 */
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  cors(res);
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(mcpHealthPayload()));
    return;
  }

  if (await handleMcpRequest(app, req, res, url.pathname)) return;

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found', mcp_endpoint: MCP_PATH }));
}

server.listen(PORT, () => {
  console.error(
    `[project-manager] MCP(HTTP) 已启动（独立模式，无认证）: http://localhost:${PORT}${MCP_PATH}\n` +
      `  数据目录: ${app.store.paths.dataDir}\n` +
      `  健康检查: http://localhost:${PORT}/health\n` +
      `  提示: 要用「看板 + API + MCP 同端口同凭据」的统一服务，请改用 pm serve`,
  );
});
