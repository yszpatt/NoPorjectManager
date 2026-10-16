import fs from 'node:fs';
import path from 'node:path';
import { emitEvent } from '../core/events.ts';
import { derivedProgress, evaluateHealth } from '../core/health.ts';
import { mergeRecords, type MergedRecord } from '../core/merge-records.ts';
import type { DailyPlan, Project, ProjectView, ReleaseInfo, Update } from '../core/types.ts';
import { clamp, newId, nowIso, toUtcIso, todayStr } from '../core/utils.ts';
import { loadConfig, saveConfig, type PMConfig } from './config.ts';
import { IndexDb, type FeedRow, type ProjectRow } from './index-db.ts';
import { parseDoc, stringifyDoc } from './markdown.ts';
import {
  ensureDirs,
  eventsFile,
  planFile,
  projectFile,
  resolvePaths,
  type Paths,
} from './paths.ts';

export interface StoreOptions {
  root?: string;
  paths?: Paths;
  config?: PMConfig;
}

/** 动态流的一行：带上项目信息，以及被并入本行的提交 */
export type MergedFeedRow = FeedRow & Pick<MergedRecord, 'commits'>;

/**
 * 存储门面。
 * 事实源 = `.projectmanager/projects/*.md` + `.projectmanager/events/*.jsonl` + `plans/*.md`
 * 索引   = `.projectmanager/index.sqlite`（可随时重建）
 */
export class Store {
  readonly paths: Paths;
  private db: IndexDb;
  /**
   * 发布统计缓存。
   * 本进程的写入会置空它；其它进程（CLI / hook / 手工重建索引）的改动靠 stamp 识别，
   * 否则长驻的界面服务会一直返回过期的发布记录。
   */
  private releaseCache: {
    stamp: number;
    map: Map<string, { count: number; latest: Update }>;
  } | null = null;

  constructor(opts: StoreOptions = {}) {
    this.paths = opts.paths ?? resolvePaths(opts.root);
    ensureDirs(this.paths);
    if (!fs.existsSync(this.paths.configFile)) {
      saveConfig(this.paths, opts.config ?? loadConfig(this.paths));
    }
    this.db = new IndexDb(this.paths.indexPath);
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------------ 配置

  get config(): PMConfig {
    return loadConfig(this.paths);
  }

  saveConfig(patch: PMConfig): void {
    saveConfig(this.paths, patch);
  }

  // ------------------------------------------------------------------ 项目

  private normalizeProject(
    raw: Record<string, unknown>,
    body: string,
    fallbackId: string,
  ): Project {
    const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : v == null ? d : String(v));
    const num = (v: unknown, d = 0): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || d;
    const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    return {
      id: str(raw.id, fallbackId),
      name: str(raw.name, fallbackId),
      description: str(raw.description),
      status: (str(raw.status, 'idea') as Project['status']) || 'idea',
      progress: clamp(Math.round(num(raw.progress, 0)), 0, 100),
      priority: (str(raw.priority, 'P2') as Project['priority']) || 'P2',
      tags: arr<string>(raw.tags).map(String),
      repos: arr<Project['repos'][number]>(raw.repos),
      target_date: raw.target_date ? str(raw.target_date) : undefined,
      created_at: str(raw.created_at, nowIso()),
      updated_at: str(raw.updated_at, nowIso()),
      goals: arr<Project['goals'][number]>(raw.goals).map((g, i) => ({
        ...g,
        id: g?.id ?? `g${i + 1}`,
      })),
      roadmap: arr<Project['roadmap'][number]>(raw.roadmap).map((r, i) => ({
        ...r,
        id: r?.id ?? `r${i + 1}`,
        status: (r?.status ?? 'planned') as Project['roadmap'][number]['status'],
      })),
      custom:
        raw.custom && typeof raw.custom === 'object' && !Array.isArray(raw.custom)
          ? (raw.custom as Record<string, unknown>)
          : {},
      body,
    };
  }

  private serializeProject(p: Project): { data: Record<string, unknown>; body: string } {
    const data: Record<string, unknown> = {
      id: p.id,
      name: p.name,
      description: p.description,
      status: p.status,
      progress: clamp(Math.round(p.progress), 0, 100),
      priority: p.priority,
    };
    if (p.tags.length) data.tags = p.tags;
    if (p.repos.length) data.repos = p.repos;
    if (p.target_date) data.target_date = p.target_date;
    data.created_at = p.created_at;
    data.updated_at = p.updated_at;
    if (p.goals.length) data.goals = p.goals;
    if (p.roadmap.length) data.roadmap = p.roadmap;
    if (Object.keys(p.custom).length) data.custom = p.custom;
    return { data, body: p.body };
  }

  readProject(id: string): Project | null {
    const file = projectFile(this.paths, id);
    if (!fs.existsSync(file)) return null;
    const doc = parseDoc(fs.readFileSync(file, 'utf8'));
    return this.normalizeProject(doc.data, doc.body, id);
  }

  /** 落盘项目（原子写）并同步索引 */
  writeProject(p: Project): void {
    const file = projectFile(this.paths, p.id);
    const { data, body } = this.serializeProject(p);
    atomicWrite(file, stringifyDoc(data, body));
    this.refreshIndexForProject(p.id);
  }

  removeProject(id: string, hard = false): void {
    const file = projectFile(this.paths, id);
    if (hard) {
      if (fs.existsSync(file)) fs.rmSync(file);
      const ev = eventsFile(this.paths, id);
      if (fs.existsSync(ev)) fs.rmSync(ev);
      this.db.deleteProject(id);
      this.releaseCache = null;
      emitEvent({ kind: 'project.deleted', project_id: id, at: nowIso() });
      return;
    }
    const p = this.readProject(id);
    if (!p) return;
    p.status = 'archived';
    p.updated_at = nowIso();
    this.writeProject(p);
    emitEvent({ kind: 'project.archived', project_id: id, at: p.updated_at });
  }

  listProjectIds(): string[] {
    if (!fs.existsSync(this.paths.projectsDir)) return [];
    return fs
      .readdirSync(this.paths.projectsDir)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .map((f) => f.slice(0, -3));
  }

  /** 从索引读取全部项目（调用方应先 ensureIndex） */
  listProjects(): Project[] {
    return this.db.listProjects().map((row) => this.rowToProject(row));
  }

  getProjectRow(id: string): ProjectRow | null {
    return this.db.getProject(id);
  }

  private rowToProject(row: ProjectRow): Project {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(row.json) as Record<string, unknown>;
    } catch {
      data = {};
    }
    return this.normalizeProject(data, row.body, row.id);
  }

  // ------------------------------------------------------------------ 事件流

  /** 追加事件：JSONL 追加写（天然 append-only、逐行可 diff） */
  appendEvent(u: Update): void {
    const file = eventsFile(this.paths, u.project_id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(u)}\n`, 'utf8');
    this.db.insertEvent(u);
    this.releaseCache = null;
    emitEvent({ kind: 'update.appended', project_id: u.project_id, at: u.ts, update: u });
  }

  newUpdate(partial: Omit<Update, 'id' | 'ts'> & { ts?: string; id?: string }): Update {
    // 先剔除 undefined，避免覆盖 id/ts 默认值（SQLite 无法绑定 undefined）
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(partial)) if (v !== undefined) clean[k] = v;
    return {
      id: (clean.id as string | undefined) ?? newId('e'),
      ts: toUtcIso((clean.ts as string | undefined) ?? nowIso()),
      ...clean,
    } as Update;
  }

  readEvents(id: string, limit = 500): Update[] {
    const file = eventsFile(this.paths, id);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const out: Update[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed = JSON.parse(t) as Update;
        // 历史文件里可能混有带本地偏移的 git 时间戳，读入时统一归一化
        out.push({ ...parsed, ts: toUtcIso(parsed.ts) });
      } catch {
        /* 跳过损坏行，保证事实源可人工编辑 */
      }
    }
    out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    return out.slice(0, limit);
  }

  eventsFromIndex(id: string, limit = 200): Update[] {
    return this.db.eventsByProject(id, limit);
  }

  recentEvents(limit = 50): Update[] {
    return this.db.recentEvents(limit);
  }

  /**
   * 自动合并的容差窗口（分钟）。0 表示只认显式声明的 refs.commit。
   * 见 core/merge-records.ts。
   */
  private mergeWindow(): number {
    const g = this.config.git;
    if (!g || g.autoLinkReports === false) return 0;
    return g.autoLinkWindowMinutes ?? 120;
  }

  /**
   * 每个项目最近 `limit` 条**合并后**的记录，键为项目 id。
   * 卡片摘要用它：提交若已并入某条汇报，就不该再单独顶在卡片上。
   */
  latestMerged(limit = 1): Map<string, MergedRecord[]> {
    const rows = this.db.recentEventsPerProject(40);
    const byProject = new Map<string, Update[]>();
    for (const e of rows) {
      const list = byProject.get(e.project_id) ?? [];
      list.push(e);
      byProject.set(e.project_id, list);
    }
    const out = new Map<string, MergedRecord[]>();
    for (const [pid, list] of byProject) {
      // list 已是 ts 倒序，mergeRecords 保持输入顺序，取前 limit 条即为最近的若干条
      const merged = mergeRecords(list, { windowMinutes: this.mergeWindow() }).slice(0, limit);
      if (merged.length) out.set(pid, merged);
    }
    return out;
  }

  /** 某项目合并后的时间线（提交事件已并入对应汇报） */
  mergedTimeline(projectId: string, limit = 50): MergedRecord[] {
    // 多取一截：合并会掉行，且配对对象可能刚好落在 limit 之外
    const raw = this.db.eventsByProject(projectId, limit + 60);
    return mergeRecords(raw, { windowMinutes: this.mergeWindow() }).slice(0, limit);
  }

  /**
   * 每个项目的发布统计（次数 + 最近一次）。
   * 结果在进程内缓存，避免逐个项目查询（每个项目都会调一次）。
   */
  releaseStats(): Map<string, { count: number; latest: Update }> {
    const stamp = this.db.dataVersion();
    if (this.releaseCache && this.releaseCache.stamp === stamp) return this.releaseCache.map;

    const map = new Map<string, { count: number; latest: Update }>();
    // allReleases 已按时间倒序，首次遇到即该项目最近一次发布
    for (const r of this.db.allReleases()) {
      const cur = map.get(r.project_id);
      if (cur) cur.count += 1;
      else map.set(r.project_id, { count: 1, latest: r });
    }
    this.releaseCache = { stamp, map };
    return map;
  }

  /** 跨项目动态流。提交已并入对应汇报——同一件事不会刷出两行 */
  feed(opts: { limit: number; projectId?: string; types?: string[] }): MergedFeedRow[] {
    // 多取一截：合并会掉行，按原 limit 取会导致返回条数不足
    const raw = this.db.feed({ ...opts, limit: opts.limit + 80 });
    const byProject = new Map<string, FeedRow[]>();
    for (const r of raw) {
      const list = byProject.get(r.project_id) ?? [];
      list.push(r);
      byProject.set(r.project_id, list);
    }

    const out: MergedFeedRow[] = [];
    for (const list of byProject.values()) {
      const meta = new Map(list.map((r) => [r.id, r]));
      // 只有同一项目内的记录之间才可能配对
      for (const m of mergeRecords(list, { windowMinutes: this.mergeWindow() })) {
        const src = meta.get(m.id);
        out.push({
          ...m,
          project_name: src?.project_name ?? '',
          project_status: src?.project_status ?? '',
        });
      }
    }
    out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return out.slice(0, opts.limit);
  }

  // ------------------------------------------------------------------ 派生视图

  /** 依据配置决定使用声明进度还是里程碑推导进度 */
  private effectiveProgress(p: Project): { progress: number; derived: boolean } {
    if (this.config.progress?.mode !== 'auto') return { progress: p.progress, derived: false };
    const d = derivedProgress(p);
    return { progress: d.value, derived: d.based === 'milestones' };
  }

  viewOf(p: Project, events?: Update[]): ProjectView {
    const ev = events ?? this.eventsFromIndex(p.id, 500);
    const eff = this.effectiveProgress(p);
    const base = eff.progress === p.progress ? p : { ...p, progress: eff.progress };
    const h = evaluateHealth(base, ev, this.config);
    const rel = this.releaseStats().get(p.id);
    return {
      ...base,
      progress_derived: eff.derived,
      last_release: rel ? toReleaseInfo(rel.latest) : null,
      release_count: rel?.count ?? 0,
      last_activity_at: h.last_activity_at,
      event_count: ev.length,
      momentum: h.momentum,
      days_since_activity: h.days_since_activity,
      days_to_target: h.days_to_target,
      health: h.health,
      health_reason: h.reason,
    };
  }

  // ------------------------------------------------------------------ 每日计划

  readPlan(date: string): DailyPlan | null {
    const file = planFile(this.paths, date);
    if (!fs.existsSync(file)) return null;
    const doc = parseDoc(fs.readFileSync(file, 'utf8'));
    const d = doc.data;
    return {
      date: typeof d.date === 'string' ? d.date : date,
      status: (d.status as DailyPlan['status']) ?? 'proposed',
      generated_by: (d.generated_by as DailyPlan['generated_by']) ?? 'agent',
      generated_at: typeof d.generated_at === 'string' ? d.generated_at : nowIso(),
      updated_at: typeof d.updated_at === 'string' ? d.updated_at : nowIso(),
      summary: typeof d.summary === 'string' ? d.summary : '',
      tasks: Array.isArray(d.tasks) ? (d.tasks as DailyPlan['tasks']) : [],
      body: doc.body,
    };
  }

  writePlan(plan: DailyPlan): void {
    const file = planFile(this.paths, plan.date);
    const data: Record<string, unknown> = {
      date: plan.date,
      status: plan.status,
      generated_by: plan.generated_by,
      generated_at: plan.generated_at,
      updated_at: plan.updated_at,
      summary: plan.summary,
    };
    if (plan.tasks.length) data.tasks = plan.tasks;
    atomicWrite(file, stringifyDoc(data, plan.body || '## 备注\n'));
    this.db.upsertPlan({
      date: plan.date,
      status: plan.status,
      generated_by: plan.generated_by,
      generated_at: plan.generated_at,
      updated_at: plan.updated_at,
      summary: plan.summary,
      json: JSON.stringify(data),
      file_mtime: fileMtime(file),
    });
    emitEvent({ kind: 'plan.written', date: plan.date, at: plan.updated_at });
  }

  listPlanDates(limit = 60): string[] {
    return this.db.listPlanDates(limit);
  }

  // ------------------------------------------------------------------ 索引维护

  /** 比对文件 mtime，增量刷新索引；返回刷新条数 */
  ensureIndex(): number {
    const known = this.db.fileMtimes();
    const ids = new Set(this.listProjectIds());
    let changed = 0;
    for (const id of ids) {
      const mtime = this.combinedMtime(id);
      if (known.get(id) !== mtime) {
        this.refreshIndexForProject(id);
        changed += 1;
      }
    }
    for (const id of known.keys()) {
      if (!ids.has(id)) {
        this.db.deleteProject(id);
        changed += 1;
      }
    }
    return changed;
  }

  rebuildIndex(): number {
    this.releaseCache = null;
    const known = this.db.fileMtimes();
    for (const id of known.keys()) this.db.deleteProject(id);
    let n = 0;
    for (const id of this.listProjectIds()) {
      this.refreshIndexForProject(id);
      n += 1;
    }
    emitEvent({ kind: 'index.rebuilt', at: nowIso() });
    return n;
  }

  private refreshIndexForProject(id: string): void {
    const p = this.readProject(id);
    if (!p) {
      this.db.deleteProject(id);
      return;
    }
    const events = this.readEvents(id, 2000);
    const eff = this.effectiveProgress(p);
    const h = evaluateHealth(
      eff.progress === p.progress ? p : { ...p, progress: eff.progress },
      events,
      this.config,
    );
    const { data } = this.serializeProject(p);
    this.db.upsertProject({
      id: p.id,
      name: p.name,
      description: p.description,
      status: p.status,
      progress: eff.progress,
      priority: p.priority,
      tags: JSON.stringify(p.tags),
      target_date: p.target_date ?? null,
      created_at: p.created_at,
      updated_at: p.updated_at,
      last_activity_at: h.last_activity_at,
      health: h.health,
      event_count: events.length,
      momentum: h.momentum,
      file_mtime: this.combinedMtime(id),
      json: JSON.stringify(data),
      body: p.body,
    });
    this.db.replaceEvents(id, events);
    this.releaseCache = null;
  }

  private combinedMtime(id: string): number {
    return Math.max(fileMtime(projectFile(this.paths, id)), fileMtime(eventsFile(this.paths, id)));
  }

  search(query: string, limit = 20): Project[] {
    return this.db.searchProjects(query, limit).map((row) => this.rowToProject(row));
  }

  /** 索引用到的所有标签 */
  allTags(): string[] {
    const tags = new Set<string>();
    for (const p of this.listProjects()) for (const t of p.tags) tags.add(t);
    return [...tags].sort();
  }

  today(): string {
    return todayStr();
  }
}

/** 把一条 release 事件翻译成对外的发布信息 */
export function toReleaseInfo(e: Update): ReleaseInfo {
  return {
    version: e.version ?? e.refs?.tag ?? '未命名版本',
    date: e.ts,
    note: e.content || undefined,
    tag: e.refs?.tag,
    commit: e.refs?.commit,
    url: e.refs?.url,
  };
}

function fileMtime(file: string): number {
  try {
    return Math.round(fs.statSync(file).mtimeMs);
  } catch {
    return 0;
  }
}

/** 先写临时文件再重命名，避免半截文件破坏事实源 */
function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}
