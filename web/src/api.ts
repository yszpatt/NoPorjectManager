import type {
  Card,
  FeedEntry,
  Plan,
  ProjectDetail,
  ProjectFull,
  RiskItem,
  Summary,
  Task,
} from './types';

const BASE = '/api';
const TOKEN_KEY = 'pm-token';

/**
 * 从 URL 读取 ?token=… 并立刻从地址栏抹掉，避免令牌留在浏览器历史/书签里。
 * 服务端用 PM_TOKEN 开启校验时，局域网内的其他设备用这个带 token 的链接即可直接进入。
 */
function takeTokenFromUrl(): string | null {
  try {
    const url = new URL(window.location.href);
    const t = url.searchParams.get('token');
    if (!t) return null;
    url.searchParams.delete('token');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    return t;
  } catch {
    return null;
  }
}

let token: string | null = takeTokenFromUrl() ?? window.localStorage.getItem(TOKEN_KEY);
if (token) window.localStorage.setItem(TOKEN_KEY, token);

function withToken(init?: RequestInit): RequestInit {
  const headers: Record<string, string> = {};
  if (init?.body) headers['content-type'] = 'application/json';
  if (token) headers['x-pm-token'] = token;
  return { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } };
}

function send(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, withToken(init));
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `请求失败 (${res.status})`;
    throw new Error(message);
  }
  return data as T;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res = await send(path, init);
  // 服务端开了令牌校验但本地还没存：问一次，存下来再重试
  if (res.status === 401) {
    const entered = window.prompt('该看板已启用访问令牌，请输入令牌：');
    if (entered && entered.trim()) {
      token = entered.trim();
      window.localStorage.setItem(TOKEN_KEY, token);
      res = await send(path, init);
    }
  }
  return parse<T>(res);
}

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export interface ProjectFilters {
  status?: string[];
  health?: string[];
  priority?: string[];
  tags?: string[];
  query?: string;
  all?: boolean;
}

export const api = {
  summary: () => request<Summary>('/summary'),

  /** 提醒：现在只报「计划停滞」 */
  reminders: () => request<{ reminders: RiskItem[] }>('/reminders?min=low'),

  /** 跨项目动态流 */
  feed: (opts: { limit?: number; project?: string; types?: string } = {}) =>
    request<FeedEntry[]>(
      `/feed${qs({ limit: opts.limit ?? 60, project: opts.project, types: opts.types })}`,
    ),

  reportRelease: (
    id: string,
    body: { version: string; note?: string; url?: string; tag?: string; date?: string },
  ) =>
    request<Card>(`/projects/${encodeURIComponent(id)}/releases`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  cards: (f: ProjectFilters) =>
    request<{ projects: Card[]; tags: string[] }>(
      `/projects${qs({
        status: f.status?.join(','),
        health: f.health?.join(','),
        priority: f.priority?.join(','),
        tags: f.tags?.join(','),
        query: f.query,
        all: f.all,
      })}`,
    ),

  /** 含 roadmap/goals 的完整视图，供时间线视图使用 */
  projectsFull: (f: ProjectFilters) =>
    request<{ projects: ProjectFull[] }>(
      `/projects${qs({
        status: f.status?.join(','),
        health: f.health?.join(','),
        priority: f.priority?.join(','),
        tags: f.tags?.join(','),
        query: f.query,
        all: f.all,
        detail: 'full',
      })}`,
    ),

  project: (id: string, timeline = 60) =>
    request<ProjectDetail>(`/projects/${encodeURIComponent(id)}?timeline=${timeline}`),

  plan: (date?: string) => request<Plan>(`/plan${qs({ date })}`),

  brief: (date?: string) => request<{ markdown: string }>(`/brief${qs({ date })}`),

  createProject: (input: Record<string, unknown>) =>
    request<Card>('/projects', { method: 'POST', body: JSON.stringify(input) }),

  updateProject: (id: string, patch: Record<string, unknown>) =>
    request<Card>(`/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteProject: (id: string, hard = false) =>
    request<{ removed: boolean }>(`/projects/${encodeURIComponent(id)}${qs({ hard })}`, {
      method: 'DELETE',
    }),

  reportProgress: (
    id: string,
    input: { content: string; delta?: number; progress?: number; type?: string },
  ) =>
    request<Card>(`/projects/${encodeURIComponent(id)}/progress`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  upsertGoal: (id: string, goal: Record<string, unknown>) =>
    request<Card>(`/projects/${encodeURIComponent(id)}/goals`, {
      method: 'POST',
      body: JSON.stringify(goal),
    }),

  removeGoal: (id: string, goalId: string) =>
    request<Card>(`/projects/${encodeURIComponent(id)}/goals/${encodeURIComponent(goalId)}`, {
      method: 'DELETE',
    }),

  upsertRoadmap: (id: string, item: Record<string, unknown>) =>
    request<Card>(`/projects/${encodeURIComponent(id)}/roadmap`, {
      method: 'POST',
      body: JSON.stringify(item),
    }),

  removeRoadmap: (id: string, itemId: string) =>
    request<Card>(`/projects/${encodeURIComponent(id)}/roadmap/${encodeURIComponent(itemId)}`, {
      method: 'DELETE',
    }),

  config: () => request<{ config: { progress?: { mode?: string } } }>('/config'),

  updateConfig: (patch: Record<string, unknown>) =>
    request<unknown>('/config', { method: 'PATCH', body: JSON.stringify(patch) }),

  linkRepo: (id: string, repo: { path?: string; url?: string; branch?: string; unlink?: boolean }) =>
    request<Card>(`/projects/${encodeURIComponent(id)}/repos`, {
      method: 'POST',
      body: JSON.stringify(repo),
    }),

  generatePlan: (body: { date?: string; max_tasks?: number; replace?: boolean; focus?: string }) =>
    request<Plan>('/plan/generate', { method: 'POST', body: JSON.stringify(body) }),

  upsertTask: (body: {
    date?: string;
    task_id?: string;
    project_id?: string;
    title: string;
    status?: string;
    estimate?: string;
  }) => request<Plan>('/plan/task', { method: 'POST', body: JSON.stringify(body) }),

  completeTask: (body: { date?: string; task_id: string; note?: string; delta?: number }) =>
    request<{ plan: Plan; task: Task }>('/plan/complete', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  setPlanStatus: (status: 'proposed' | 'active' | 'closed', date?: string) =>
    request<Plan>('/plan/status', { method: 'POST', body: JSON.stringify({ status, date }) }),

  syncGit: (projectId?: string) =>
    request<{ events_created: number; commits_seen: number; warnings: string[] }>('/git/sync', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId }),
    }),
};
