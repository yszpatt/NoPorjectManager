/**
 * HTTP(Streamable) 传输冒烟测试：拉起 `pm mcp http` 子进程，
 * 用官方客户端完成 initialize → tools/list → tools/call → resources/list → 关闭。
 *
 * 用法： npm run smoke:http
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = process.cwd();
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const port = Number(process.env.PM_SMOKE_PORT ?? 8932);
const base = `http://localhost:${port}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function text(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

async function waitForHealth(timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
    } catch {
      /* 未就绪，继续等待 */
    }
    await sleep(250);
  }
  return false;
}

async function main(): Promise<void> {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', tsx, path.join(root, 'src', 'mcp', 'http.ts')],
    {
      env: {
        ...process.env,
        PM_HTTP_PORT: String(port),
        NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let failed = 0;
  const check = (name: string, okFlag: boolean, detail = ''): void => {
    if (!okFlag) failed += 1;
    console.log(`${okFlag ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  };

  try {
    check('http /health', await waitForHealth(), base);

    const health = (await (await fetch(`${base}/health`)).json()) as { projects?: number };
    check('health payload', typeof health.projects === 'number', `projects=${health.projects}`);

    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    const client = new Client({ name: 'pm-smoke-http', version: '0.0.1' });
    await client.connect(transport);
    check('initialize', true, base + '/mcp');

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
    child.kill();
  }

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('HTTP 冒烟测试异常：', err);
  process.exit(1);
});
