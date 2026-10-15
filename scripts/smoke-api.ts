/**
 * 看板 REST API 冒烟测试：拉起 `pm ui` 子进程，
 * 覆盖 静态页面 → 汇总 → 项目 CRUD → 进展/规划写入 → 计划生成与闭环。
 *
 * 用法： npm run smoke:api
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const port = Number(process.env.PM_SMOKE_PORT ?? 8934);
const base = `http://localhost:${port}`;
const TEST_ID = 'smoke-api-test';

/** 隔离的数据目录：冒烟测试不应污染用户真实的 .projectmanager */
const dataDir = path.join(root, '.artifacts', 'smoke-api');
fs.rmSync(dataDir, { recursive: true, force: true });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

async function req<T>(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data: data as T };
}

async function waitForHealth(timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {
      /* 未就绪 */
    }
    await sleep(250);
  }
  return false;
}

async function main(): Promise<void> {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', tsx, path.join(root, 'src', 'cli', 'index.ts'), 'serve', '--port', String(port)],
    {
      cwd: root,
      env: {
        ...process.env,
        PM_DATA_DIR: dataDir,
        NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  try {
    check('服务启动 /api/health', await waitForHealth(), base);

    // 静态页面
    const html = await fetch(`${base}/`);
    const htmlText = await html.text();
    check('静态页面', html.status === 200 && htmlText.includes('id="root"'), `${html.status}`);

    // 查询
    const summary = await req<{ totals: { projects: number } }>('GET', '/api/summary');
    check('GET /api/summary', summary.status === 200 && typeof summary.data.totals.projects === 'number');

    const list = await req<{ projects: unknown[]; tags: string[] }>('GET', '/api/projects');
    check('GET /api/projects', list.status === 200 && Array.isArray(list.data.projects));

    const reminders = await req<{ reminders: unknown[] }>('GET', '/api/reminders');
    check('GET /api/reminders', reminders.status === 200 && Array.isArray(reminders.data.reminders));

    // 清理上次残留
    await req('DELETE', `/api/projects/${TEST_ID}?hard=1`);

    // 创建
    const created = await req<{ id: string; progress: number }>('POST', '/api/projects', {
      id: TEST_ID,
      name: 'API 冒烟测试项目',
      description: '由 scripts/smoke-api.ts 创建',
      status: 'active',
      progress: 10,
      priority: 'P3',
      tags: ['test'],
      target_date: '2026-12-01',
      roadmap: [{ id: 'r1', title: '打通 REST 链路', due: '2026-10-14' }],
    });
    check('POST /api/projects', created.status === 200 && created.data.id === TEST_ID);

    // 更新（同时触发时间线事件）
    const patched = await req<{ progress: number; status: string }>(
      'PATCH',
      `/api/projects/${TEST_ID}`,
      { progress: 40, status: 'active' },
    );
    check('PATCH /api/projects/:id', patched.data.progress === 40);

    // 进展
    const progressed = await req<{ progress: number }>('POST', `/api/projects/${TEST_ID}/progress`, {
      content: 'REST 链路验证',
      delta: 10,
    });
    check('POST /api/projects/:id/progress', progressed.data.progress === 50);

    // 发布记录
    const released = await req<{ last_release: { version: string } | null; release_count: number }>(
      'POST',
      `/api/projects/${TEST_ID}/releases`,
      { version: 'v0.2.0', note: '重写导入链路', url: 'https://example.com/v0.2.0' },
    );
    check(
      'POST /api/projects/:id/releases',
      released.data.last_release?.version === 'v0.2.0' && released.data.release_count === 1,
    );

    const releaseList = await req<{ releases: Array<{ version: string }> }>(
      'GET',
      `/api/projects/${TEST_ID}/releases`,
    );
    check('GET /api/projects/:id/releases', releaseList.data.releases.length === 1);

    const feed = await req<Array<{ type: string; project_id: string }>>('GET', '/api/feed?limit=30');
    check(
      'GET /api/feed',
      Array.isArray(feed.data) && feed.data.some((e) => e.type === 'release'),
      `${feed.data?.length} 条`,
    );

    // 目标 / 路线图
    const goal = await req<{ goals: unknown[] }>('POST', `/api/projects/${TEST_ID}/goals`, {
      title: '接口全部可用',
      metric: '接口数',
      target: 20,
      current: 18,
      due: '2026-11-30',
    });
    check('POST /api/projects/:id/goals', Array.isArray(goal.data.goals) && goal.data.goals.length === 1);

    const roadmap = await req<{ roadmap: unknown[] }>('POST', `/api/projects/${TEST_ID}/roadmap`, {
      id: 'r2',
      title: '补齐错误处理',
      due: '2026-11-10',
      status: 'planned',
    });
    check('POST /api/projects/:id/roadmap', Array.isArray(roadmap.data.roadmap));

    // 详情（含时间线）
    const detail = await req<{ timeline: unknown[]; event_count: number }>(
      'GET',
      `/api/projects/${TEST_ID}`,
    );
    check(
      'GET /api/projects/:id',
      Array.isArray(detail.data.timeline) && detail.data.timeline.length >= 3,
      `事件 ${detail.data.timeline?.length} 条`,
    );

    // 计划
    const plan = await req<{ tasks: Array<{ id: string; status: string }> }>(
      'POST',
      '/api/plan/generate',
      { max_tasks: 6 },
    );
    check('POST /api/plan/generate', plan.status === 200 && plan.data.tasks.length > 0, `${plan.data.tasks?.length} 项`);

    const open = plan.data.tasks.find((t) => t.status !== 'done');
    const completed = await req<{ task: { status: string } }>('POST', '/api/plan/complete', {
      task_id: open?.id,
      note: '冒烟测试完成',
      delta: 5,
    });
    check('POST /api/plan/complete', completed.data.task?.status === 'done');

    const added = await req<{ tasks: unknown[] }>('POST', '/api/plan/task', {
      title: '手工添加的任务',
      project_id: TEST_ID,
    });
    check('POST /api/plan/task', Array.isArray(added.data.tasks));

    // 配置
    const cfg = await req<{ config: { health: { staleAfterDays: number } } }>('GET', '/api/config');
    check('GET /api/config', typeof cfg.data.config.health.staleAfterDays === 'number');

    // 清理
    const removed = await req<{ removed: boolean }>('DELETE', `/api/projects/${TEST_ID}?hard=1`);
    check('DELETE /api/projects/:id', removed.data.removed === true);

    const after = await req<{ projects: Array<{ id: string }> }>('GET', '/api/projects?detail=full');
    check('清理完成', !after.data.projects.some((p) => p.id === TEST_ID));

    const notFound = await req('GET', '/api/projects/__nope__');
    check('404 语义', notFound.status === 404, `${notFound.status}`);

    // ---------------------------------------------------------------- 访问鉴权
    // 这一段会真的把服务切成需要认证，所以放在最后，前面的断言都还没被影响

    const auth0 = await req<{ enabled: boolean; source: string; min_password_length: number }>(
      'GET',
      '/api/auth',
    );
    check(
      'GET /api/auth（初始未启用）',
      auth0.status === 200 && auth0.data.enabled === false && auth0.data.source === 'none',
      `source=${auth0.data.source}`,
    );

    const tooShort = await req('PUT', '/api/auth', { user: 'tester', password: '123' });
    check('PUT /api/auth 口令太短 → 400', tooShort.status === 400, `${tooShort.status}`);

    const noUser = await req('PUT', '/api/auth', { user: '  ', password: 'smoke-pass-123' });
    check('PUT /api/auth 用户名为空 → 400', noUser.status === 400, `${noUser.status}`);

    const applied = await req<{ enabled: boolean; source: string; user: string }>(
      'PUT',
      '/api/auth',
      { user: 'tester', password: 'smoke-pass-123' },
    );
    check(
      'PUT /api/auth 启用（source=file）',
      applied.status === 200 && applied.data.enabled === true && applied.data.source === 'file',
      `source=${applied.data.source} user=${applied.data.user}`,
    );

    const auth = (user: string, password: string): Record<string, string> => ({
      authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
    });

    const afterEnable = await fetch(`${base}/api/summary`);
    check('启用后无凭据 → 401', afterEnable.status === 401, `${afterEnable.status}`);
    check(
      '401 带 WWW-Authenticate',
      /^Basic\s+realm=/i.test(afterEnable.headers.get('www-authenticate') ?? ''),
      afterEnable.headers.get('www-authenticate') ?? '(缺失)',
    );

    const wrongPass = await fetch(`${base}/api/summary`, { headers: auth('tester', 'nope') });
    check('启用后口令错 → 401', wrongPass.status === 401, `${wrongPass.status}`);

    const withCreds = await fetch(`${base}/api/summary`, {
      headers: auth('tester', 'smoke-pass-123'),
    });
    check('启用后凭据正确 → 200', withCreds.status === 200, `${withCreds.status}`);

    const mcpUnauthorized = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    check('启用后 MCP 无凭据 → 401', mcpUnauthorized.status === 401, `${mcpUnauthorized.status}`);

    // CLI 是在另一个进程里改的 auth.json：运行中的服务应当在几秒内跟上
    const reset = spawnSync(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        tsx,
        path.join(root, 'src', 'cli', 'index.ts'),
        'auth',
        'reset',
      ],
      { cwd: root, env: { ...process.env, PM_DATA_DIR: dataDir }, encoding: 'utf8' },
    );
    check('pm auth reset 执行成功', reset.status === 0, reset.stdout?.trim().split('\n')[0] ?? '');

    await sleep(3500);
    const afterReset = await fetch(`${base}/api/summary`);
    check('reset 后服务自动跟进（不再要求凭据）', afterReset.status === 200, `${afterReset.status}`);

    const authAfter = await req<{ enabled: boolean; source: string }>('GET', '/api/auth');
    check('reset 后来源回到 none', authAfter.data.source === 'none', `source=${authAfter.data.source}`);
  } finally {
    child.kill();
  }

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('API 冒烟测试异常：', err);
  process.exit(1);
});
