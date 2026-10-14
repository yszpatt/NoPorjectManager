import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.ts';
import { discoverRepos, syncGit } from '../collectors/git.ts';
import { analyzeRisks } from '../core/risk.ts';
import type { CreateProjectInput } from '../core/project-service.ts';
import type { ProjectFilter, ProjectStatus, SourceKind, UpdateType } from '../core/types.ts';
import { mergeConfig } from '../store/config.ts';

const DEFAULT_PORT = 8930;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distDir = path.join(repoRoot, 'web', 'dist');

/**
 * 访问令牌。为 null 表示不校验 —— 只应在「仅本机回环」的绑定下使用。
 * 一旦开放到局域网，强烈建议同时设置令牌。
 */
let accessToken: string | null = null;

interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  req: IncomingMessage;
  res: ServerResponse;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

const app = createApp();
const routes: Route[] = [];

/** 极简路由注册：`/api/projects/:id/goals` → 带命名参数的匹配 */
function route(method: string, pattern: string, handler: Handler): void {
  const keys: string[] = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (!seg.startsWith(':')) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      keys.push(seg.slice(1));
      return '([^/]+)';
    })
    .join('/');
  routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler });
}

function str(q: URLSearchParams, key: string): string | undefined {
  const v = q.get(key);
  return v === null || v === '' ? undefined : v;
}

function list(q: URLSearchParams, key: string): string[] | undefined {
  const raw = str(q, key);
  return raw ? raw.split(',').filter(Boolean) : undefined;
}

function bool(q: URLSearchParams, key: string): boolean {
  const v = q.get(key);
  return v === '1' || v === 'true';
}

function num(q: URLSearchParams, key: string): number | undefined {
  const v = str(q, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------- 汇总与查询

route('GET', '/api/health', () => ({
  ok: true,
  dataDir: app.store.paths.dataDir,
  projects: app.projects.list({ include_archived: true }).length,
  ui: fs.existsSync(path.join(distDir, 'index.html')) ? 'built' : 'missing',
}));

route('GET', '/api/summary', () => app.projects.summary());

route('GET', '/api/reminders', ({ query }) => {
  const stalled = num(query, 'stalled') ?? app.store.config.reminders.planStalledAfterDays;
  const min = (str(query, 'min') ?? 'low') as 'high' | 'medium' | 'low';
  const rank = { high: 0, medium: 1, low: 2 };
  return {
    reminders: analyzeRisks(app.projects, stalled).filter((r) => rank[r.level] <= rank[min]),
  };
});

/** 跨项目动态流 */
route('GET', '/api/feed', ({ query }) =>
  app.projects.feed({
    limit: num(query, 'limit') ?? 80,
    project_id: str(query, 'project'),
    types: list(query, 'types') as UpdateType[] | undefined,
  }),
);

route('GET', '/api/projects', ({ query }) => {
  const filter: ProjectFilter = {
    status: list(query, 'status') as ProjectStatus[] | undefined,
    health: list(query, 'health') as ProjectFilter['health'],
    priority: list(query, 'priority') as ProjectFilter['priority'],
    tags: list(query, 'tags'),
    query: str(query, 'query'),
    include_archived: bool(query, 'all'),
    limit: num(query, 'limit'),
  };
  const detail = str(query, 'detail') === 'full';
  return {
    projects: detail
      ? app.projects.list(filter).map((p) => ({ ...p, body: undefined }))
      : app.projects.cards(filter),
    tags: app.store.allTags(),
  };
});

route('GET', '/api/projects/:id', ({ params, query }) => {
  const detail = app.projects.get(params.id!, {
    timeline_limit: num(query, 'timeline') ?? 40,
  });
  if (!detail) throw httpError(404, `项目不存在: ${params.id}`);
  return detail;
});

route('GET', '/api/projects/:id/timeline', ({ params, query }) => ({
  project_id: params.id,
  events: app.projects.timeline(params.id!, num(query, 'limit') ?? 100),
}));

// ---------------------------------------------------------------- 项目写入

route('POST', '/api/projects', ({ body }) => {
  const input = (body ?? {}) as Record<string, unknown>;
  return app.projects.create({
    name: String(input.name ?? ''),
    id: input.id ? String(input.id) : undefined,
    description: input.description ? String(input.description) : undefined,
    status: input.status as CreateProjectInput['status'],
    progress: typeof input.progress === 'number' ? input.progress : undefined,
    priority: input.priority as CreateProjectInput['priority'],
    tags: Array.isArray(input.tags) ? input.tags.map(String) : undefined,
    target_date: input.target_date ? String(input.target_date) : undefined,
    goals: input.goals as CreateProjectInput['goals'],
    roadmap: input.roadmap as CreateProjectInput['roadmap'],
    body: input.body ? String(input.body) : undefined,
    source: 'user',
  });
});

route('PATCH', '/api/projects/:id', ({ params, body }) => {
  const patch = (body ?? {}) as Record<string, unknown>;
  return app.projects.update(params.id!, {
    ...(patch as Parameters<typeof app.projects.update>[1]),
    source: 'user',
  });
});

route('DELETE', '/api/projects/:id', ({ params, query }) => {
  const hard = bool(query, 'hard');
  return app.projects.remove(params.id!, hard);
});

route('POST', '/api/projects/:id/progress', ({ params, body }) => {
  const input = (body ?? {}) as Record<string, unknown>;
  return app.projects.reportProgress(params.id!, {
    content: String(input.content ?? ''),
    delta: typeof input.delta === 'number' ? input.delta : undefined,
    progress: typeof input.progress === 'number' ? input.progress : undefined,
    type: input.type as UpdateType | undefined,
    actor: input.actor ? String(input.actor) : undefined,
    refs: input.refs as Record<string, string> | undefined,
    // 来源可由调用方声明：浏览器是人工，Agent 经 REST 写入时应自称 agent。
    // 早先写死 'user'，导致 Agent 的写入在看板上被标成「人工」。
    source: normalizeSource(input.source),
  });
});

route('GET', '/api/projects/:id/releases', ({ params }) => ({
  releases: app.projects.releases(params.id!),
}));

route('POST', '/api/projects/:id/releases', ({ params, body }) => {
  const o = (body ?? {}) as Record<string, unknown>;
  return app.projects.reportRelease(params.id!, {
    version: String(o.version ?? ''),
    note: o.note ? String(o.note) : undefined,
    url: o.url ? String(o.url) : undefined,
    tag: o.tag ? String(o.tag) : undefined,
    date: o.date ? String(o.date) : undefined,
    actor: o.actor ? String(o.actor) : undefined,
    source: normalizeSource(o.source),
  });
});

route('POST', '/api/projects/:id/goals', ({ params, body }) => {
  const g = (body ?? {}) as Record<string, unknown>;
  return app.projects.upsertGoal(params.id!, {
    ...(g as Parameters<typeof app.projects.upsertGoal>[1]),
    title: String(g.title ?? ''),
  });
});

route('DELETE', '/api/projects/:id/goals/:goalId', ({ params }) =>
  app.projects.removeGoal(params.id!, params.goalId!),
);

route('POST', '/api/projects/:id/roadmap', ({ params, body }) => {
  const r = (body ?? {}) as Record<string, unknown>;
  return app.projects.upsertRoadmapItem(params.id!, {
    ...(r as Parameters<typeof app.projects.upsertRoadmapItem>[1]),
    title: String(r.title ?? ''),
  });
});

route('DELETE', '/api/projects/:id/roadmap/:itemId', ({ params }) =>
  app.projects.removeRoadmapItem(params.id!, params.itemId!),
);

route('POST', '/api/projects/:id/repos', ({ params, body }) => {
  const r = (body ?? {}) as { path?: string; url?: string; branch?: string; unlink?: boolean };
  const key = r.path ?? r.url;
  if (!key) throw httpError(400, '需要 path 或 url');
  return r.unlink
    ? app.projects.unlinkRepo(params.id!, key)
    : app.projects.linkRepo(params.id!, { path: r.path, url: r.url, branch: r.branch });
});

// ---------------------------------------------------------------- 每日计划

route('GET', '/api/plan', ({ query }) => {
  const date = str(query, 'date') ?? app.store.today();
  return app.plans.get(date) ?? { date, status: 'none', tasks: [], summary: '' };
});

route('POST', '/api/plan/generate', ({ body }) => {
  const o = (body ?? {}) as Record<string, unknown>;
  const { plan, candidates } = app.plans.generate({
    date: o.date ? String(o.date) : undefined,
    maxTasks: typeof o.max_tasks === 'number' ? o.max_tasks : undefined,
    replace: o.replace === true,
    focus: o.focus ? String(o.focus) : undefined,
    source: 'user',
  });
  return { ...plan, candidate_count: candidates };
});

route('POST', '/api/plan/task', ({ body }) => {
  const o = (body ?? {}) as Record<string, unknown>;
  const date = String(o.date ?? app.store.today());
  const title = String(o.title ?? '');
  if (!title) throw httpError(400, 'title 不能为空');
  if (o.task_id) {
    return app.plans.updateTask(date, String(o.task_id), {
      title,
      status: o.status as 'todo' | 'doing' | 'done' | undefined,
      estimate: o.estimate ? String(o.estimate) : undefined,
      rationale: o.rationale ? String(o.rationale) : undefined,
      project_id: o.project_id ? String(o.project_id) : undefined,
    });
  }
  return app.plans.addTask(date, {
    title,
    project_id: o.project_id ? String(o.project_id) : undefined,
    status: (o.status as 'todo' | 'doing' | 'done') ?? 'todo',
    estimate: o.estimate ? String(o.estimate) : undefined,
    source: 'user',
  });
});

route('POST', '/api/plan/complete', ({ body }) => {
  const o = (body ?? {}) as Record<string, unknown>;
  const date = String(o.date ?? app.store.today());
  const taskId = String(o.task_id ?? '');
  if (!taskId) throw httpError(400, 'task_id 不能为空');
  const { plan, task } = app.plans.completeTask(date, taskId, {
    note: o.note ? String(o.note) : undefined,
    delta: typeof o.delta === 'number' ? o.delta : undefined,
    progress: typeof o.progress === 'number' ? o.progress : undefined,
    actor: '看板',
  });
  return { plan, task };
});

route('POST', '/api/plan/status', ({ body }) => {
  const o = (body ?? {}) as Record<string, unknown>;
  const status = String(o.status ?? '') as 'proposed' | 'active' | 'closed';
  if (!['proposed', 'active', 'closed'].includes(status)) throw httpError(400, 'status 非法');
  return app.plans.setStatus(String(o.date ?? app.store.today()), status);
});

route('GET', '/api/brief', ({ query }) => ({
  markdown: app.plans.brief(str(query, 'date')),
}));

// ---------------------------------------------------------------- 集成与配置

route('POST', '/api/git/sync', ({ body }) => {
  const o = (body ?? {}) as Record<string, unknown>;
  // 不要传 actor：对 commit 来说「谁做的」就是提交者本人，调用方标签不该覆盖它
  return syncGit(app.store, app.projects, {
    projectId: o.project_id ? String(o.project_id) : undefined,
    since: o.since ? String(o.since) : undefined,
    maxCommits: typeof o.max_commits === 'number' ? o.max_commits : 200,
  });
});

route('GET', '/api/discover-repos', ({ query }) => {
  const depth = num(query, 'depth') ?? 2;
  try {
    return { repos: discoverRepos(app.store.paths.root, depth) };
  } catch (e) {
    return { repos: [], warning: (e as Error).message };
  }
});

route('GET', '/api/config', () => ({ paths: app.store.paths, config: app.store.config }));

route('PATCH', '/api/config', ({ body }) => {
  const next = mergeConfig(app.store.config, (body ?? {}) as Record<string, unknown>);
  app.store.saveConfig(next);
  return next;
});

route('POST', '/api/reindex', () => ({ rebuilt: app.store.rebuildIndex() }));

// ---------------------------------------------------------------- HTTP 基础设施

const SOURCE_KINDS: ReadonlySet<string> = new Set(['agent', 'user', 'git', 'integration']);

/** 归一化来源，非法值一律回落到 user */
function normalizeSource(v: unknown): SourceKind {
  const s = typeof v === 'string' ? v : '';
  return (SOURCE_KINDS.has(s) ? s : 'user') as SourceKind;
}

function httpError(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw httpError(400, '请求体不是合法 JSON');
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function serveStatic(res: ServerResponse, urlPath: string): void {
  const indexFile = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexFile)) {
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<meta charset="utf-8"><body style="font-family:system-ui;padding:40px;line-height:1.7">` +
        `<h2>看板前端尚未构建</h2>` +
        `<pre style="background:#f4f4f5;padding:12px;border-radius:8px">npm run ui:build</pre>` +
        `<p>或使用开发模式：<code>npm run ui:dev</code>（http://localhost:8933）</p>` +
        `<p>API 已可用：<a href="/api/summary">/api/summary</a></p></body>`,
    );
    return;
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const candidate = path.resolve(distDir, rel);
  // 防目录穿越
  const safe = candidate.startsWith(distDir) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate
    : indexFile;
  res.writeHead(200, {
    'content-type': MIME[path.extname(safe).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': safe === indexFile ? 'no-cache' : 'public, max-age=3600',
  });
  res.end(fs.readFileSync(safe));
}

/**
 * 只对「同源」请求回 CORS 头。
 *
 * 早先无条件返回 `Access-Control-Allow-Origin: *`，意味着任意网页都能在你
 * 打开它时悄悄读写本机看板（DNS 重绑定 / CSRF）。同源放行即可满足需求：
 * 页面与 API 始终由同一个服务提供，Vite 开发代理也是服务端转发。
 */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try {
      if (new URL(origin).host === host) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
    } catch {
      /* 非法 Origin，直接忽略 */
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-pm-token');
}

/** 定长比较，避免通过响应时间反推令牌 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function isAuthorized(req: IncomingMessage, url: URL): boolean {
  if (!accessToken) return true;
  const raw = req.headers['x-pm-token'];
  const provided = (Array.isArray(raw) ? raw[0] : raw) ?? url.searchParams.get('token') ?? '';
  return provided !== '' && safeEqual(provided, accessToken);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const urlPath = url.pathname;

  if (!urlPath.startsWith('/api/')) {
    serveStatic(res, urlPath);
    return;
  }

  if (!isAuthorized(req, url)) {
    sendJson(res, 401, {
      error: '未授权：请在页面 URL 上附加 ?token=… 或设置 x-pm-token 请求头',
    });
    return;
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.regex.exec(urlPath);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? '')));
    try {
      const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await readBody(req);
      const result = await r.handler({ params, query: url.searchParams, body, req, res });
      if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
    } catch (e) {
      const err = e as Error & { status?: number };
      if (!res.headersSent) sendJson(res, err.status ?? 500, { error: err.message });
    }
    return;
  }

  sendJson(res, 404, { error: `未知接口: ${req.method} ${urlPath}` });
}

/** 列出本机所有非回环 IPv4 地址，用于打印局域网访问入口 */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      out.push(ni.address);
    }
  }
  return out;
}

export interface ApiServerOptions {
  port?: number;
  /** 绑定地址。默认仅本机回环；局域网访问用 '0.0.0.0' */
  host?: string;
  /** 访问令牌；设置后 /api/* 必须携带 */
  token?: string | null;
}

export function startApiServer(options: ApiServerOptions | number = {}): http.Server {
  const opts = typeof options === 'number' ? { port: options } : options;
  const port = opts.port ?? Number(process.env.PM_UI_PORT ?? DEFAULT_PORT);
  const host = opts.host ?? process.env.PM_HOST ?? '127.0.0.1';
  accessToken = (opts.token ?? process.env.PM_TOKEN ?? '').trim() || null;

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  server.listen(port, host, () => {
    const exposed = host !== '127.0.0.1' && host !== 'localhost';
    const suffix = accessToken ? `/?token=${accessToken}` : '/';
    const lines = ['[project-manager] 看板服务已启动'];
    lines.push(`  本机:   http://localhost:${port}${suffix}`);

    if (exposed) {
      const addrs = lanAddresses();
      if (addrs.length) {
        for (const a of addrs) lines.push(`  局域网: http://${a}:${port}${suffix}`);
      } else {
        lines.push('  局域网: 未检测到可用的局域网 IPv4 地址');
      }
      lines.push('  提示: 首次访问可能被 Windows 防火墙拦截，需要放行该端口');
      if (!accessToken) {
        lines.push('  警告: 未设置访问令牌，同网络内的任何人都可读写、归档甚至删除看板数据');
        lines.push('        建议改为: pm ui --lan --token <一段随机字符串>');
      }
    } else if (accessToken) {
      lines.push('  已启用访问令牌校验');
    }

    if (!fs.existsSync(path.join(distDir, 'index.html'))) {
      lines.push('  注意: 前端尚未构建，先执行 npm run ui:build');
    }
    lines.push(`  数据:   ${app.store.paths.dataDir}`);
    console.error(lines.join('\n'));
  });

  return server;
}

/** 允许直接 `node src/api/server.ts` 启动 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startApiServer();
}
