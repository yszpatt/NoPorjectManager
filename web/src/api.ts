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

/**
 * 这里没有任何令牌存取逻辑 —— 服务端启用认证时用的是 HTTP Basic：
 * 浏览器会自行弹出原生登录框、把凭据缓存下来，并在后续请求上自动携带。
 * 前端不该、也不需要接触口令。
 */
function send(path: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init?.body) headers['content-type'] = 'application/json';
  return fetch(`${BASE}${path}`, {
    ...init,
    // 调用方显式传的 headers 优先级更高（保持与改动前一致）
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
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
  // 401 交给浏览器：它会弹一次原生登录框，认证通过后自动重发这个请求。
  // 曾经的实现在这里 window.prompt，并发请求会各弹一次，输入完还在弹。
  return parse<T>(await send(path, init));
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
