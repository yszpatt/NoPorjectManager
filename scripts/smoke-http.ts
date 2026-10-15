/**
 * HTTP 传输冒烟测试。两段：
 *
 *   A) 统一服务（`pm serve`）：看板 REST 与 MCP 在同一个端口、共用同一套 Basic 凭据。
 *   B) 独立模式（`pm mcp http`）：只有 MCP 端点、没有认证，确认这条兼容路径仍然可用。
 *
 * 用法： npm run smoke:http
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = process.cwd();
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const tsxArgs = (entry: string): string[] => [
  '--disable-warning=ExperimentalWarning',
  tsx,
  path.join(root, entry),
];

const PORT = Number(process.env.PM_SMOKE_PORT ?? 8932);
const PORT_STANDALONE = Number(process.env.PM_SMOKE_PORT_STANDALONE ?? 8933);
const PASSWORD = 'smoke-secret';
const DATA_DIR = path.join(root, '.artifacts', 'smoke-http');
fs.rmSync(DATA_DIR, { recursive: true, force: true });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const basic = (password: string): string =>
  `Basic ${Buffer.from(`pm:${password}`).toString('base64')}`;

function text(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

async function waitForOk(url: string, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* 未就绪，继续等 */
    }
    await sleep(250);
  }
  return false;
}

let failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

function spawnService(entry: string, port: number, extraEnv: Record<string, string> = {}) {
  return spawn(process.execPath, tsxArgs(entry), {
    env: {
      ...process.env,
      PM_DATA_DIR: DATA_DIR,
      PM_UI_PORT: String(port),
      PM_HTTP_PORT: String(port),
      NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function mcpClient(base: string, authorization?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: authorization ? { headers: { authorization } } : undefined,
  });
  const client = new Client({ name: 'pm-smoke-http', version: '0.0.1' });
  await client.connect(transport);
  return client;
}

/** A) 统一服务：同端口、同凭据 */
async function smokeUnified(): Promise<void> {
  const base = `http://localhost:${PORT}`;
  const auth = basic(PASSWORD);
  const proc = spawn(
    process.execPath,
    [...tsxArgs('src/cli/index.ts'), 'serve', `--port=${PORT}`, `--password=${PASSWORD}`],
    {
      env: {
        ...process.env,
        PM_DATA_DIR: DATA_DIR,
        NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  try {
    check('统一服务 /health 就绪（免认证）', await waitForOk(`${base}/health`), `${base}/health`);

    const health = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    check('health 只回存活信息', health.ok === true, JSON.stringify(health));

    const restNoAuth = await fetch(`${base}/api/health`);
    check('REST 无凭据 → 401', restNoAuth.status === 401, `status=${restNoAuth.status}`);

    const restAuth = await fetch(`${base}/api/health`, { headers: { authorization: auth } });
    check('REST 带凭据 → 200', restAuth.status === 200, `status=${restAuth.status}`);

    const restBad = await fetch(`${base}/api/health`, { headers: { authorization: basic('wrong') } });
    check('REST 口令错误 → 401', restBad.status === 401, `status=${restBad.status}`);

    const mcpNoAuth = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    check('MCP 无凭据 → 401', mcpNoAuth.status === 401, `status=${mcpNoAuth.status}`);

    const page = await fetch(`${base}/`);
    check('看板静态页可访问（不需认证）', page.ok, `status=${page.status}`);

    const client = await mcpClient(base, auth);
    check('MCP 带凭据 initialize', true, `${base}/mcp`);

    const tools = await client.listTools();
    check('tools/list', tools.tools.length >= 18, `${tools.tools.length} 个工具`);

    const summary = JSON.parse(text(await client.callTool({ name: 'pm_summary', arguments: {} })));
    check('pm_summary', typeof summary.totals?.projects === 'number', `项目数 ${summary.totals?.projects}`);

    const cards = JSON.parse(
      text(await client.callTool({ name: 'pm_list_projects', arguments: { limit: 5 } })),
    );
    check('pm_list_projects', Array.isArray(cards.projects));

    await client.close();
  } finally {
    proc.kill();
  }
}

/** B) 独立模式：只有 MCP、没有认证 */
async function smokeStandalone(): Promise<void> {
  const base = `http://localhost:${PORT_STANDALONE}`;
  const proc = spawnService('src/mcp/http.ts', PORT_STANDALONE);

  try {
    check('独立模式 /health 就绪', await waitForOk(`${base}/health`), `${base}/health`);

    const client = await mcpClient(base);
    const tools = await client.listTools();
    check('独立模式 tools/list', tools.tools.length >= 18, `${tools.tools.length} 个工具`);
    await client.close();
  } finally {
    proc.kill();
  }
}

/** C) --no-mcp：MCP 端点应当明确报 404，而不是被 SPA 静态兜底吞成一段 HTML */
async function smokeNoMcp(): Promise<void> {
  // 8935：避开 smoke:api 的 8934，两个冒烟测试可以并行跑
  const port = Number(process.env.PM_SMOKE_PORT_NO_MCP ?? 8935);
  const base = `http://localhost:${port}`;
  const proc = spawn(
    process.execPath,
    [...tsxArgs('src/cli/index.ts'), 'serve', `--port=${port}`, '--no-mcp'],
    {
      env: {
        ...process.env,
        PM_DATA_DIR: DATA_DIR,
        NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  try {
    check('--no-mcp /health 就绪', await waitForOk(`${base}/health`), `${base}/health`);
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const body = (await res.json()) as { error?: string };
    check('--no-mcp 时 /mcp → 404 JSON', res.status === 404, `status=${res.status} ${body.error ?? ''}`);
  } finally {
    proc.kill();
  }
}

async function main(): Promise<void> {
  await smokeUnified();
  await smokeStandalone();
  await smokeNoMcp();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('HTTP 冒烟测试异常：', err);
  process.exit(1);
});
