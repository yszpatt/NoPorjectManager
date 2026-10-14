import { emitEvent } from './events.ts';
import { reminderOf } from './risk.ts';
import { toReleaseInfo, type Store } from '../store/repo.ts';
import type {
  Goal,
  Project,
  ProjectFilter,
  ProjectStatus,
  ProjectView,
  ReleaseInfo,
  RoadmapItem,
  SourceKind,
  Summary,
  Update,
  UpdateType,
} from './types.ts';
import type { LinkedCommit, MergedRecord } from './merge-records.ts';
import { clamp, firstLine, isBlank, newId, nowIso, slugify, truncate } from './utils.ts';

export interface CreateProjectInput {
  id?: string;
  name: string;
  description?: string;
  status?: ProjectStatus;
  progress?: number;
  priority?: Project['priority'];
  tags?: string[];
  target_date?: string;
  goals?: Array<Partial<Goal> & { title: string }>;
  roadmap?: Array<Partial<RoadmapItem> & { title: string }>;
  custom?: Record<string, unknown>;
  body?: string;
  source?: SourceKind;
  actor?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  status?: ProjectStatus;
  progress?: number;
  priority?: Project['priority'];
  tags?: string[];
  target_date?: string | null;
  custom?: Record<string, unknown>;
  body?: string;
  source?: SourceKind;
  actor?: string;
  /** 透传到自动生成的审计事件上，用于把变更关联回引发它的提交 */
  refs?: Record<string, string>;
}

export interface ReportProgressInput {
  content: string;
  type?: UpdateType;
  /** 绝对进度，优先级高于 delta */
  progress?: number;
  /** 增量进度 */
  delta?: number;
  source?: SourceKind;
  actor?: string;
  refs?: Record<string, string>;
  ts?: string;
  /** 系统拼出的占位文案（如「完成计划任务：…」），标记后不参与提交的自动合并 */
  auto?: boolean;
}

export interface TimelineEntry {
  ts: string;
  source: SourceKind;
  type: UpdateType;
  content: string;
  delta?: number;
  /** 发布事件携带的版本号 */
  version?: string;
  actor?: string;
  refs?: Record<string, string>;
  /** 已并入本条记录的提交（原本单独的 git 记录不再出现） */
  commits?: LinkedCommit[];
}

export interface ProjectDetail extends ProjectView {
  timeline?: TimelineEntry[];
  /** 发布历史（从事件流倒推），详情页单独成块展示 */
  releases?: ReleaseInfo[];
}

export class ProjectService {
  constructor(private readonly store: Store) {}

  private syncIndex(): void {
    this.store.ensureIndex();
  }

  // ------------------------------------------------------------------ 查询

  list(filter: ProjectFilter = {}): ProjectView[] {
    this.syncIndex();
    const views = this.store.listProjects().map((p) => this.store.viewOf(p));
    const q = filter.query?.toLowerCase().trim();
    let out = views.filter((p) => {
      if (!filter.include_archived && p.status === 'archived') return false;
      if (filter.status?.length && !filter.status.includes(p.status)) return false;
      if (filter.health?.length && !filter.health.includes(p.health)) return false;
      if (filter.priority?.length && !filter.priority.includes(p.priority)) return false;
      if (filter.tags?.length && !filter.tags.some((t) => p.tags.includes(t))) return false;
      if (q) {
        const hay = `${p.id} ${p.name} ${p.description} ${p.tags.join(' ')} ${p.body}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    out = out.sort(
      (a, b) =>
        healthRank(a.health) - healthRank(b.health) ||
        a.priority.localeCompare(b.priority) ||
        b.updated_at.localeCompare(a.updated_at),
    );
    return filter.limit ? out.slice(0, filter.limit) : out;
  }

  get(
    id: string,
    include: { timeline?: boolean; timeline_limit?: number } = {},
  ): ProjectDetail | null {
    this.syncIndex();
    const p = this.store.readProject(id);
    if (!p) return null;
    const view = this.store.viewOf(p);
    const result: ProjectDetail = { ...view };
    if (include.timeline !== false) {
      result.timeline = this.store
        .mergedTimeline(id, include.timeline_limit ?? 30)
        .map((e) => ({
          ts: e.ts,
          source: e.source,
          type: e.type,
          content: e.content,
          delta: e.delta,
          version: e.version,
          actor: e.actor,
          refs: e.refs,
          commits: e.commits,
        }));
    }
    result.releases = this.releases(id);
    return result;
  }

  /**
   * 卡片级视图：适合 agent 批量读取、看板渲染。
   * 按"自用工具"的关注点组织——发布记录、后续计划、最近思考在前，
   * 进度百分比与截止日期保留在数据里（详情页用），但不作为卡片的信息主体。
   */
  cards(filter: ProjectFilter = {}) {
    // 合并后的最新记录：提交若已并入某条汇报，就不该再单独顶在卡片上
    const latest = this.store.latestMerged();
    const stalledAfter = this.store.config.reminders.planStalledAfterDays;
    return this.list(filter).map((p) => {
      const last = latest.get(p.id);
      return {
        id: p.id,
        name: p.name,
        description: truncate(p.description, 120),
        status: p.status,
        priority: p.priority,
        tags: p.tags,
        health: p.health,
        health_reason: p.health_reason,
        momentum: p.momentum,
        event_count: p.event_count,
        days_since_activity: p.days_since_activity,
        updated_at: p.updated_at,
        /** 最近一次发布与累计次数 —— 独立开发最值得留档的东西 */
        last_release: p.last_release,
        release_count: p.release_count,
        /** 后续计划：最近一项未完成项（不要求有日期）+ 其余条数 */
        next_plan: roadmapFocus(p),
        /** 最近一条思考/记录 */
        // 记录是「结论 + 分条」格式，卡片只留结论那一行
        last_update: last
          ? {
              source: last.source,
              type: last.type,
              ts: last.ts,
              content: truncate(firstLine(last.content), 90),
            }
          : null,
        /** 计划停滞提醒；没有命中则为 null */
        reminder: reminderOf(p, stalledAfter),
        /** 以下字段保留给详情页与 agent，看板卡片不展示 */
        progress: p.progress,
        progress_derived: p.progress_derived,
        target_date: p.target_date ?? null,
        days_to_target: p.days_to_target,
        goals: p.goals,
        open_goals: p.goals.filter((g) => (g.status ?? 'open') === 'open').length,
      };
    });
  }

  /** 记录一次发布。独立开发里，发布是最该被留档的事件。 */
  reportRelease(
    id: string,
    input: {
      version: string;
      note?: string;
      url?: string;
      tag?: string;
      date?: string;
      actor?: string;
      source?: SourceKind;
    },
  ): ProjectView {
    const p = this.require(id);
    const version = input.version?.trim();
    if (!version) throw new Error('发布必须提供 version，例如 v0.3.2');
    const refs: Record<string, string> = {};
    if (input.tag) refs.tag = input.tag;
    if (input.url) refs.url = input.url;
    p.updated_at = nowIso();
    this.store.writeProject(p);
    this.store.appendEvent(
      this.store.newUpdate({
        project_id: id,
        source: input.source ?? 'user',
        type: 'release',
        content: input.note?.trim() || `发布 ${version}`,
        version,
        actor: input.actor,
        ts: input.date,
        refs: Object.keys(refs).length ? refs : undefined,
      }),
    );
    return this.store.viewOf(p);
  }

  /** 某项目的发布历史（由事件流倒推） */
  releases(id: string, limit = 50): ReleaseInfo[] {
    this.require(id);
    return this.store
      .eventsFromIndex(id, 1000)
      .filter((e) => e.type === 'release')
      .slice(0, limit)
      .map(toReleaseInfo);
  }

  /** 跨项目动态流：按时间倒序的原始记录，可按项目或类型筛选 */
  feed(opts: { limit?: number; project_id?: string; types?: UpdateType[] } = {}) {
    this.syncIndex();
    return this.store.feed({
      limit: opts.limit ?? 80,
      projectId: opts.project_id,
      types: opts.types?.length ? opts.types : undefined,
    });
  }

  // ------------------------------------------------------------------ 写入

  create(input: CreateProjectInput): ProjectView {
    if (isBlank(input.name)) throw new Error('项目 name 不能为空');
    this.syncIndex();
    const id = input.id?.trim() || slugify(input.name);
    if (this.store.readProject(id)) {
      throw new Error(`项目已存在: ${id}`);
    }
    const now = nowIso();
    const p: Project = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      status: input.status ?? 'idea',
      progress: clamp(input.progress ?? 0, 0, 100),
      priority: input.priority ?? 'P2',
      tags: input.tags ?? [],
      repos: [],
      target_date: input.target_date,
      created_at: now,
      updated_at: now,
      goals: (input.goals ?? []).map((g, i) => ({
        id: g.id ?? `g${i + 1}`,
        ...g,
        status: g.status ?? ('open' as const),
      })),
      roadmap: (input.roadmap ?? [])
        .map((r, i) => ({
          id: r.id ?? `r${i + 1}`,
          ...r,
          status: r.status ?? ('planned' as const),
        }))
        .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999')),
      custom: input.custom ?? {},
      body: input.body ?? this.defaultBody(input),
    };
    this.store.writeProject(p);
    this.store.appendEvent(
      this.store.newUpdate({
        project_id: id,
        source: input.source ?? 'user',
        type: 'note',
        content: `创建项目「${p.name}」`,
        actor: input.actor,
        // 系统生成的占位记录，不承载叙述，不该被当成提交的合并宿主
        auto: true,
      }),
    );
    emitEvent({ kind: 'project.created', project_id: id, at: now });
    return this.store.viewOf(p);
  }

  update(id: string, patch: UpdateProjectInput): ProjectView {
    const p = this.require(id);
    const changed: string[] = [];
    const events: Array<Partial<Update> & { type: UpdateType; content: string }> = [];

    if (!isBlank(patch.name) && patch.name !== p.name) {
      p.name = patch.name!.trim();
      changed.push('name');
    }
    if (patch.description !== undefined && patch.description !== p.description) {
      p.description = patch.description;
      changed.push('description');
    }
    if (patch.tags) {
      p.tags = [...new Set(patch.tags)];
      changed.push('tags');
    }
    if (patch.priority && patch.priority !== p.priority) {
      p.priority = patch.priority;
      changed.push('priority');
    }
    if (patch.target_date !== undefined) {
      p.target_date = patch.target_date ?? undefined;
      changed.push('target_date');
    }
    if (patch.custom) {
      p.custom = { ...p.custom, ...patch.custom };
      changed.push('custom');
    }
    if (patch.body !== undefined && patch.body !== p.body) {
      p.body = patch.body;
      changed.push('body');
    }
    if (patch.status && patch.status !== p.status) {
      events.push({
        type: 'status',
        content: `状态 ${p.status} → ${patch.status}`,
        source: patch.source,
        actor: patch.actor,
        refs: patch.refs,
        // 系统生成的审计事件：只记录变更本身，不承载叙述（见 merge-records.ts）
        auto: true,
      });
      p.status = patch.status;
      changed.push('status');
    }
    if (patch.progress !== undefined && clamp(patch.progress, 0, 100) !== p.progress) {
      const next = clamp(Math.round(patch.progress), 0, 100);
      events.push({
        type: 'progress',
        content: `进度 ${p.progress}% → ${next}%`,
        delta: next - p.progress,
        source: patch.source,
        actor: patch.actor,
        refs: patch.refs,
        auto: true,
      });
      p.progress = next;
      changed.push('progress');
    }

    if (!changed.length) return this.store.viewOf(p);
    p.updated_at = nowIso();
    this.store.writeProject(p);
    for (const e of events) {
      // 展开而不是逐字段抄：漏抄一个字段（refs / auto）会让合并静默失效
      this.store.appendEvent(
        this.store.newUpdate({
          ...e,
          project_id: id,
          source: e.source ?? patch.source ?? 'user',
          actor: e.actor ?? patch.actor,
        }),
      );
    }
    emitEvent({ kind: 'project.updated', project_id: id, at: p.updated_at, fields: changed });
    return this.store.viewOf(p);
  }

  /** 汇报进展：追加事件流，可选同时修正进度 */
  reportProgress(id: string, input: ReportProgressInput): ProjectView {
    const p = this.require(id);
    let delta: number | undefined;
    if (input.progress !== undefined) {
      const next = clamp(Math.round(input.progress), 0, 100);
      delta = next - p.progress;
      p.progress = next;
    } else if (input.delta !== undefined && input.delta !== 0) {
      const next = clamp(p.progress + Math.round(input.delta), 0, 100);
      delta = next - p.progress;
      p.progress = next;
    }
    p.updated_at = nowIso();
    this.store.writeProject(p);
    this.store.appendEvent(
      this.store.newUpdate({
        project_id: id,
        source: input.source ?? 'agent',
        type: input.type ?? (delta ? 'progress' : 'note'),
        content: input.content,
        delta,
        actor: input.actor,
        refs: input.refs,
        ts: input.ts,
      }),
    );
    return this.store.viewOf(p);
  }

  upsertGoal(id: string, goal: Partial<Goal> & { title: string }): ProjectView {
    const p = this.require(id);
    const existing = goal.id ? p.goals.find((g) => g.id === goal.id) : undefined;
    if (existing) {
      Object.assign(existing, goal);
    } else {
      p.goals.push({ id: goal.id ?? newId('g'), status: 'open', ...goal });
    }
    p.updated_at = nowIso();
    this.store.writeProject(p);
    return this.store.viewOf(p);
  }

  removeGoal(id: string, goalId: string): ProjectView {
    const p = this.require(id);
    p.goals = p.goals.filter((g) => g.id !== goalId);
    p.updated_at = nowIso();
    this.store.writeProject(p);
    return this.store.viewOf(p);
  }

  upsertRoadmapItem(
    id: string,
    item: Partial<RoadmapItem> & { title: string },
  ): ProjectView {
    const p = this.require(id);
    const existing = item.id ? p.roadmap.find((r) => r.id === item.id) : undefined;
    if (existing) {
      Object.assign(existing, item);
    } else {
      p.roadmap.push({ id: item.id ?? newId('r'), status: 'planned', ...item });
    }
    p.roadmap.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
    p.updated_at = nowIso();
    this.store.writeProject(p);
    return this.store.viewOf(p);
  }

  removeRoadmapItem(id: string, itemId: string): ProjectView {
    const p = this.require(id);
    p.roadmap = p.roadmap.filter((r) => r.id !== itemId);
    p.updated_at = nowIso();
    this.store.writeProject(p);
    return this.store.viewOf(p);
  }

  linkRepo(id: string, repo: { path?: string; url?: string; branch?: string }): ProjectView {
    const p = this.require(id);
    const key = repo.path ?? repo.url;
    if (!key) throw new Error('repo 需要 path 或 url');
    const dup = p.repos.some((r) => (r.path ?? r.url) === key);
    if (!dup) p.repos.push(repo);
    p.updated_at = nowIso();
    this.store.writeProject(p);
    return this.store.viewOf(p);
  }

  unlinkRepo(id: string, key: string): ProjectView {
    const p = this.require(id);
    p.repos = p.repos.filter((r) => (r.path ?? r.url) !== key);
    p.updated_at = nowIso();
    this.store.writeProject(p);
    return this.store.viewOf(p);
  }

  remove(id: string, hard = false): { id: string; removed: boolean; hard: boolean } {
    this.require(id);
    this.store.removeProject(id, hard);
    return { id, removed: true, hard };
  }

  timeline(id: string, limit = 50): MergedRecord[] {
    this.require(id);
    return this.store.mergedTimeline(id, limit);
  }

  // ------------------------------------------------------------------ 汇总

  summary(): Summary {
    this.syncIndex();
    const all = this.store.listProjects().map((p) => this.store.viewOf(p));
    const live = all.filter((p) => p.status !== 'archived');
    const byStatus = countBy(all, (p) => p.status);
    const byHealth = countBy(live, (p) => p.health);
    const today = this.store.today();
    const plan = this.store.readPlan(today);

    const atRisk = live
      .filter((p) => p.health === 'at_risk')
      .sort((a, b) => (a.days_to_target ?? 999) - (b.days_to_target ?? 999))
      .slice(0, 10)
      .map((p) => ({
        id: p.id,
        name: p.name,
        reason: p.health_reason,
        progress: p.progress,
        target_date: p.target_date,
      }));

    const stale = live
      .filter((p) => p.health === 'stale')
      .sort((a, b) => b.days_since_activity - a.days_since_activity)
      .slice(0, 10)
      .map((p) => ({ id: p.id, name: p.name, days_since_activity: p.days_since_activity }));

    const blocked = live
      .filter((p) => p.status === 'blocked')
      .map((p) => ({ id: p.id, name: p.name }));

    const upcoming = live
      .filter((p) => p.target_date && (p.days_to_target ?? 999) >= 0 && (p.days_to_target ?? 999) <= 30)
      .sort((a, b) => (a.days_to_target ?? 0) - (b.days_to_target ?? 0))
      .slice(0, 10)
      .map((p) => ({
        id: p.id,
        name: p.name,
        target_date: p.target_date!,
        days_left: p.days_to_target ?? 0,
        progress: p.progress,
      }));

    return {
      generated_at: nowIso(),
      totals: {
        projects: all.length,
        active: live.filter((p) => p.status === 'active').length,
        archived: all.length - live.length,
        avg_progress: live.length
          ? Math.round(live.reduce((s, p) => s + p.progress, 0) / live.length)
          : 0,
      },
      by_status: byStatus,
      by_health: byHealth,
      at_risk: atRisk,
      stale,
      blocked,
      upcoming,
      today_plan: plan
        ? {
            date: plan.date,
            status: plan.status,
            open_tasks: plan.tasks.filter((t) => t.status !== 'done').length,
            total_tasks: plan.tasks.length,
          }
        : null,
    };
  }

  private require(id: string): Project {
    this.syncIndex();
    const p = this.store.readProject(id);
    if (!p) throw new Error(`项目不存在: ${id}`);
    return p;
  }

  private defaultBody(input: CreateProjectInput): string {
    const lines = ['## 介绍', '', input.description?.trim() || '（待补充）', ''];
    if (input.goals?.length) {
      lines.push('## 目标', '', ...input.goals.map((g) => `- ${g.title}`), '');
    }
    return lines.join('\n').trimEnd();
  }
}

function healthRank(h: string): number {
  return { blocked: 0, at_risk: 1, stale: 2, unknown: 3, on_track: 4, done: 5 }[h] ?? 6;
}

/**
 * 取"最该被看到的"一项未来规划。
 *
 * 不强制要求有 due：早先只挑有日期的条目，导致"进行中但未排期"的里程碑
 * 在卡片上完全消失，而它恰恰是最该被看到的。
 * 优先级：进行中（同日取更早）→ 有日期的取最早 → 任意未完成项。
 */
function roadmapFocus(
  p: ProjectView,
): { title: string; due?: string; remaining: number } | null {
  const open = p.roadmap.filter((r) => r.status !== 'done' && r.status !== 'dropped');
  if (!open.length) return null;
  // 无日期排最后，避免排期未定的条目抢占位置
  const byDue = (
    a: { due?: string },
    b: { due?: string },
  ): number => (a.due ?? '9999-12-31').localeCompare(b.due ?? '9999-12-31');
  const inProgress = open.filter((r) => r.status === 'in_progress').sort(byDue);
  const pick = inProgress[0] ?? [...open].filter((r) => r.due).sort(byDue)[0] ?? open[0]!;
  return { title: pick.title, due: pick.due, remaining: open.length - 1 };
}



function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
