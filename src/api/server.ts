import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.ts';
import { discoverRepos, syncGit } from '../collectors/git.ts';
import { handleMcpRequest, mcpHealthPayload, MCP_PATH } from '../mcp/http-handler.ts';
import { analyzeRisks } from '../core/risk.ts';
import type { CreateProjectInput } from '../core/project-service.ts';
import type { ProjectFilter, ProjectStatus, SourceKind, UpdateType } from '../core/types.ts';
import { mergeConfig } from '../store/config.ts';
import {
  authFilePath,
  clearAuth,
  loadAuth,
  MIN_PASSWORD_LENGTH,
  saveAuth,
  verifyAuth,
  type AuthRecord,
} from '../store/auth.ts';

const DEFAULT_PORT = 8930;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distDir = path.join(repoRoot, 'web', 'dist');

/**
 * 当前生效的凭据来源：
 * - `file`：在看板面板里设置的（`.projectmanager/auth.json`，只存 scrypt 派生值）
 * - `env` ：来自 PM_USER / PM_PASSWORD，明文只活在进程内存里
 * - `none`：不校验 —— 只应在「仅本机回环」的绑定下使用
 *
 * 面板优先于环境变量：面板是用户当下的显式意图，环境变量是部署时的默认值。
 * 清除面板凭据后会回落到环境变量（用 `pm auth reset` 或面板上的按钮）。
 *
 * 用 Basic 而不是自定义令牌，是因为浏览器对 Basic 的原生弹窗只弹一次、
 * 之后自动携带凭据：前端不需要任何令牌存取逻辑，也就不存在「并发请求各弹一次」
 * 这种毛病；curl / Agent 侧用 `-u user:pass` 也直接可用。
 */
type AuthSource = 'file' | 'env' | 'none';

interface AuthState {
  source: AuthSource;
  /** 当前生效的用户名（`none` 时只是展示用的默认值） */
  user: string;
}

let authState: AuthState = { source: 'none', user: 'pm' };
/** 环境变量里的凭据（明文，仅内存） */
let envUser = 'pm';
let envPassword: string | null = null;
/** 面板凭据（派生值） */
let fileAuth: AuthRecord | null = null;

/**
 * 已验证凭据的缓存：key = sha256(user\0password)，value = 写入时的凭据代数。
 * scrypt 一次要几十毫秒，不能每个请求都跑；凭据一改代数就 +1，旧条目自动失效。
 *
 * 只缓存**成功**的凭据，所以错误的尝试不会把内存撑大。
 */
let authGeneration = 0;
const verifiedCredentials = new Map<string, number>();

/** 凭据被外部改动（`pm auth set/reset`、手工删文件）后的跟进间隔 */
const AUTH_RELOAD_INTERVAL_MS = 3000;
let lastAuthReloadAt = 0;

/**
 * 依据磁盘上的 auth.json 与环境变量重算当前生效的凭据。
 *
 * 只有**实际变了**才换代号、清缓存 —— 否则每 3 秒一次的空转重读会把
 * scrypt 校验缓存冲掉，白白让每个请求多花几十毫秒。
 */
function reloadAuth(): void {
  lastAuthReloadAt = Date.now();
  const next = loadAuth(app.store.paths);
  const nextSource: AuthSource = next ? 'file' : envPassword ? 'env' : 'none';
  const nextUser = next ? next.user : envUser;
  const changed =
    authState.source !== nextSource ||
    authState.user !== nextUser ||
    (fileAuth?.hash ?? '') !== (next?.hash ?? '');

  fileAuth = next;
  authState = { source: nextSource, user: nextUser };
  if (changed) {
    authGeneration += 1;
    verifiedCredentials.clear();
  }
}

/** 每个请求最多每 3 秒看一眼磁盘，跟上外部进程的修改 */
function maybeReloadAuth(): void {
  if (Date.now() - lastAuthReloadAt < AUTH_RELOAD_INTERVAL_MS) return;
  reloadAuth();
}

/** 是否在同一端口上挂载 MCP(Streamable HTTP) 端点；默认开启 */
let mcpEnabled = true;

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

// ---------------------------------------------------------------- 访问鉴权

/** 启动日志里给「凭据从哪来」一个中文说法 */
function authSourceLabel(): string {
  return authState.source === 'file' ? '面板管理' : '环境变量';
}

function authStatus(): Record<string, unknown> {
  return {
    enabled: authState.source !== 'none',
    /** file = 面板管理；env = 由 PM_USER/PM_PASSWORD 控制；none = 未启用 */
    source: authState.source,
    user: authState.user,
    /** 环境变量里也配了口令：清除面板凭据后会回落到它 */
    env_configured: envPassword !== null,
    /** 面板凭据的落盘位置，改错了可以删掉它重来 */
    file: authFilePath(app.store.paths),
    min_password_length: MIN_PASSWORD_LENGTH,
  };
}

route('GET', '/api/auth', () => authStatus());

route('PUT', '/api/auth', ({ body }) => {
  const o = (body ?? {}) as Record<string, unknown>;
  const user = String(o.user ?? '').trim();
  const password = String(o.password ?? '');
  if (!user) throw httpError(400, '用户名不能为空');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw httpError(400, `口令至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
  saveAuth(app.store.paths, user, password);
  // 立刻生效：旧凭据随即失效，浏览器下一次请求会重新弹登录框
  reloadAuth();
  return authStatus();
});

route('DELETE', '/api/auth', () => {
  clearAuth(app.store.paths);
  reloadAuth();
  return authStatus();
});

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
  // MCP 客户端会带这几个头；浏览器的预检必须放行，否则 MCP 端点会卡在 OPTIONS
  res.setHeader(
    'Access-Control-Allow-Headers',
    'content-type, authorization, mcp-session-id, mcp-protocol-version',
  );
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');
}

/** 定长比较，避免通过响应时间反推口令 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** 解析 `Authorization: Basic base64(user:pass)` */
function parseBasic(req: IncomingMessage): { user: string; password: string } | null {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header || !/^basic\s/i.test(header)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(header.replace(/^basic\s+/i, '').trim(), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return null;
  return { user: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

/** 拿当前生效的凭据比对一次（env 走明文比对，file 走 scrypt） */
function credentialsMatch(user: string, password: string): boolean {
  if (authState.source === 'env') {
    // 两个都比较完再返回，避免短路暴露「用户名是否正确」
    return safeEqual(user, authState.user) && safeEqual(password, envPassword ?? '');
  }
  return fileAuth !== null && verifyAuth(fileAuth, user, password);
}

/** 校验请求凭据；结果按凭据摘要缓存，避免每个请求都跑 scrypt */
function isAuthorized(req: IncomingMessage): boolean {
  maybeReloadAuth();
  if (authState.source === 'none') return true;

  const parsed = parseBasic(req);
  if (!parsed) return false;

  const cacheKey = createHash('sha256')
    .update(`${parsed.user}\u0000${parsed.password}`, 'utf8')
    .digest('hex');
  if (verifiedCredentials.get(cacheKey) === authGeneration) return true;

  if (credentialsMatch(parsed.user, parsed.password)) {
    verifiedCredentials.set(cacheKey, authGeneration);
    return true;
  }
  return false;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const urlPath = url.pathname;

  // 免认证的就绪探针：只回「活着」。数据目录、项目数这类信息在 /api/health，走认证。
  if (urlPath === '/health') {
    sendJson(res, 200, mcpHealthPayload());
    return;
  }

  // 用 --no-mcp 关掉后要明说，否则 SPA 的静态兜底会回一段 HTML，
  // MCP 客户端只会看到「解析失败」，很难定位。
  if (!mcpEnabled && urlPath === MCP_PATH) {
    sendJson(res, 404, { error: 'MCP 端点已关闭', hint: '去掉 --no-mcp（或设 PM_MCP=1）后重启' });
    return;
  }

  // MCP 与看板共用一个端口，也共用同一套凭据：先过认证，再分派
  const isMcp = mcpEnabled && urlPath === MCP_PATH;
  const isApi = urlPath.startsWith('/api/');

  if (isMcp || isApi) {
    if (!isAuthorized(req)) {
      // 必须带 WWW-Authenticate（且含 realm），浏览器才会弹出原生登录框。
      // realm 只能是 ASCII —— 头部出现非 ASCII 字符会让 setHeader 直接抛错。
      // charset="UTF-8" 按 RFC 7617 声明凭据编码，中文口令才不会乱。
      res.setHeader('WWW-Authenticate', 'Basic realm="Project Board", charset="UTF-8"');
      sendJson(res, 401, { error: '未授权：需要 HTTP Basic 凭据' });
      return;
    }
    if (isMcp) {
      await handleMcpRequest(app, req, res, urlPath);
      return;
    }
  }

  if (!isApi) {
    serveStatic(res, urlPath);
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
  /** Basic 认证用户名，默认 pm */
  user?: string;
  /** Basic 认证口令；设置后 /api/* 与 MCP 端点都必须携带凭据 */
  password?: string | null;
  /** 是否在同一端口上挂载 MCP(Streamable HTTP) 端点，默认 true（`PM_MCP=0` 可关） */
  mcp?: boolean;
}

export function startApiServer(options: ApiServerOptions | number = {}): http.Server {
  const opts = typeof options === 'number' ? { port: options } : options;
  const port = opts.port ?? Number(process.env.PM_UI_PORT ?? DEFAULT_PORT);
  const host = opts.host ?? process.env.PM_HOST ?? '127.0.0.1';
  envUser = (opts.user ?? process.env.PM_USER ?? 'pm').trim() || 'pm';
  // PM_PASSWORD 是当前的名字；PM_TOKEN 保留为别名，旧部署的 .env 不至于失效
  envPassword =
    (opts.password ?? process.env.PM_PASSWORD ?? process.env.PM_TOKEN ?? '').trim() || null;
  // 面板里设的凭据优先；没有才回落到环境变量
  reloadAuth();
  mcpEnabled = opts.mcp ?? process.env.PM_MCP !== '0';

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  server.listen(port, host, () => {
    const exposed = host !== '127.0.0.1' && host !== 'localhost';
    const lines = ['[project-manager] 统一服务已启动（看板 + REST API + MCP）'];
    lines.push(`  本机:   http://localhost:${port}/`);

    if (exposed) {
      const addrs = lanAddresses();
      if (addrs.length) {
        for (const a of addrs) lines.push(`  局域网: http://${a}:${port}/`);
      } else {
        lines.push('  局域网: 未检测到可用的局域网 IPv4 地址');
      }
      lines.push('  提示: 首次访问可能被 Windows 防火墙拦截，需要放行该端口');
      if (authState.source !== 'none') {
        lines.push(
          `  认证:   Basic，用户名 ${authState.user}（${authSourceLabel()}）；浏览器首次打开会弹出登录框`,
        );
      } else {
        lines.push('  警告: 未设置访问口令，同网络内的任何人都可读写、归档甚至删除看板数据');
        lines.push('        可在看板「设置」里设置，或启动时加 --password <口令>');
      }
    } else if (authState.source !== 'none') {
      lines.push(`  已启用 Basic 认证（用户名 ${authState.user}，${authSourceLabel()}）`);
    }

    if (mcpEnabled) {
      lines.push(`  MCP:    http://localhost:${port}${MCP_PATH}（与看板共用凭据）`);
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
