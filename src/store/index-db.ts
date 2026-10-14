import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Update } from '../core/types.ts';
import { toUtcIso } from '../core/utils.ts';

/**
 * SQLite 索引：纯派生缓存，可随时由 Markdown 事实源重建。
 * 承担「汇总 / 过滤 / 全文检索」等查询职责，不承担事实源职责。
 */

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  status: string;
  progress: number;
  priority: string;
  tags: string;
  target_date: string | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string | null;
  health: string;
  event_count: number;
  momentum: number;
  file_mtime: number;
  json: string;
  body: string;
}

export interface FeedRow extends Update {
  project_name: string;
  project_status: string;
}

export interface PlanRow {
  date: string;
  status: string;
  generated_by: string;
  generated_at: string;
  updated_at: string;
  summary: string;
  json: string;
  file_mtime: number;
}

/**
 * 索引结构版本。索引是纯派生数据，结构变更直接丢弃重建即可，
 * 不需要写增量迁移脚本。
 */
const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'idea',
  progress         INTEGER NOT NULL DEFAULT 0,
  priority         TEXT NOT NULL DEFAULT 'P2',
  tags             TEXT NOT NULL DEFAULT '[]',
  target_date      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_activity_at TEXT,
  health           TEXT NOT NULL DEFAULT 'unknown',
  event_count      INTEGER NOT NULL DEFAULT 0,
  momentum         REAL NOT NULL DEFAULT 0,
  file_mtime       INTEGER NOT NULL DEFAULT 0,
  json             TEXT NOT NULL DEFAULT '{}',
  body             TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_health ON projects(health);
CREATE INDEX IF NOT EXISTS idx_projects_target ON projects(target_date);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  ts         TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'user',
  type       TEXT NOT NULL DEFAULT 'note',
  content    TEXT NOT NULL DEFAULT '',
  delta      INTEGER,
  version    TEXT,
  actor      TEXT,
  refs       TEXT,
  auto       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);

CREATE TABLE IF NOT EXISTS plans (
  date         TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'proposed',
  generated_by TEXT NOT NULL DEFAULT 'agent',
  generated_at TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  json         TEXT NOT NULL DEFAULT '{}',
  file_mtime   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class IndexDb {
  private db: DatabaseSync;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** 结构版本不一致时丢弃并重建（索引可随时由 Markdown 事实源重建） */
  private migrate(): void {
    if (this.getMeta('schema_version') === String(SCHEMA_VERSION)) return;
    this.db.exec(`
      DROP TABLE IF EXISTS events;
      DROP TABLE IF EXISTS projects;
      DROP TABLE IF EXISTS plans;
    `);
    this.db.exec(SCHEMA);
    this.setMeta('schema_version', String(SCHEMA_VERSION));
  }

  /**
   * 其它连接提交过修改时该值会变化（本连接自身的修改不会）。
   *
   * 用途：索引会被 CLI、hook 等其它进程重建，而界面服务是长驻进程。
   * 进程内缓存必须据此判断是否失效——WAL 模式下主库文件 mtime 并不可靠。
   */
  dataVersion(): number {
    const row = this.db.prepare('PRAGMA data_version').get() as
      | { data_version?: number }
      | undefined;
    return Number(row?.data_version ?? 0);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  // ---------- projects ----------

  upsertProject(row: ProjectRow): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, description, status, progress, priority, tags,
           target_date, created_at, updated_at, last_activity_at, health, event_count,
           momentum, file_mtime, json, body)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, description=excluded.description, status=excluded.status,
           progress=excluded.progress, priority=excluded.priority, tags=excluded.tags,
           target_date=excluded.target_date, created_at=excluded.created_at,
           updated_at=excluded.updated_at, last_activity_at=excluded.last_activity_at,
           health=excluded.health, event_count=excluded.event_count, momentum=excluded.momentum,
           file_mtime=excluded.file_mtime, json=excluded.json, body=excluded.body`,
      )
      .run(
        row.id,
        row.name,
        row.description,
        row.status,
        row.progress,
        row.priority,
        row.tags,
        row.target_date,
        row.created_at,
        row.updated_at,
        row.last_activity_at,
        row.health,
        row.event_count,
        row.momentum,
        row.file_mtime,
        row.json,
        row.body,
      );
  }

  deleteProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM events WHERE project_id = ?').run(id);
  }

  getProject(id: string): ProjectRow | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    return (row as unknown as ProjectRow) ?? null;
  }

  listProjects(): ProjectRow[] {
    return this.db
      .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
      .all() as unknown as ProjectRow[];
  }

  projectCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
    return row?.n ?? 0;
  }

  /** 简易全文检索：名称 / 描述 / 正文 / 标签 */
  searchProjects(query: string, limit = 20): ProjectRow[] {
    const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    return this.db
      .prepare(
        `SELECT * FROM projects
         WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'
            OR body LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\'
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(like, like, like, like, like, limit) as unknown as ProjectRow[];
  }

  /** 文件 mtime 映射，用于判断事实源是否变化 */
  fileMtimes(): Map<string, number> {
    const rows = this.db
      .prepare('SELECT id, file_mtime FROM projects')
      .all() as unknown as Array<{ id: string; file_mtime: number }>;
    return new Map(rows.map((r) => [r.id, r.file_mtime]));
  }

  // ---------- events ----------

  replaceEvents(projectId: string, events: Update[]): void {
    this.db.prepare('DELETE FROM events WHERE project_id = ?').run(projectId);
    const stmt = this.db.prepare(EVENT_UPSERT);
    for (const e of events) stmt.run(...eventParams(e));
  }

  insertEvent(e: Update): void {
    this.db.prepare(EVENT_UPSERT).run(...eventParams(e));
  }

  /** 所有发布事件，按时间倒序（交由调用方按项目分组） */
  allReleases(): Update[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE type = 'release' ORDER BY ts DESC")
      .all() as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToUpdate);
  }

  /** 跨项目动态流：按时间倒序的原始记录，带项目名与状态 */
  feed(opts: { limit: number; projectId?: string; types?: string[] }): FeedRow[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.projectId) {
      where.push('e.project_id = ?');
      params.push(opts.projectId);
    }
    if (opts.types?.length) {
      where.push(`e.type IN (${opts.types.map(() => '?').join(',')})`);
      params.push(...opts.types);
    }
    const sql =
      `SELECT e.*, p.name AS project_name, p.status AS project_status` +
      ` FROM events e JOIN projects p ON p.id = e.project_id` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY e.ts DESC LIMIT ?`;
    params.push(opts.limit);
    const rows = this.db.prepare(sql).all(...params) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ...rowToUpdate(r),
      project_name: String(r.project_name ?? ''),
      project_status: String(r.project_status ?? ''),
    }));
  }

  /**
   * 每个项目最近的 N 条事件（窗口函数取分区前 N）。
   * 用于「卡片摘要」这类只关心每个项目最新记录的场景，避免把整表拉出来。
   */
  recentEventsPerProject(perProject = 40): Update[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT e.*, ROW_NUMBER() OVER (PARTITION BY e.project_id ORDER BY e.ts DESC) AS rn
           FROM events e
         ) WHERE rn <= ?`,
      )
      .all(perProject) as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToUpdate);
  }

  eventsByProject(projectId: string, limit = 200): Update[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE project_id = ? ORDER BY ts DESC LIMIT ?')
      .all(projectId, limit) as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToUpdate);
  }

  latestEventTs(projectId: string): string | null {
    const row = this.db
      .prepare('SELECT ts FROM events WHERE project_id = ? ORDER BY ts DESC LIMIT 1')
      .get(projectId) as { ts?: string } | undefined;
    return row?.ts ?? null;
  }

  /** 各项目最近一次事件时间，用于健康度计算 */
  lastEventTsMap(): Map<string, string> {
    const rows = this.db
      .prepare('SELECT project_id, MAX(ts) AS ts FROM events GROUP BY project_id')
      .all() as unknown as Array<{ project_id: string; ts: string }>;
    return new Map(rows.map((r) => [r.project_id, r.ts]));
  }

  /** 各项目近 N 天内的事件数 + 累计增量，用于 momentum */
  momentumMap(sinceIso: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT project_id, COUNT(*) AS n, COALESCE(SUM(ABS(COALESCE(delta,0))),0) AS d
         FROM events WHERE ts >= ? GROUP BY project_id`,
      )
      .all(sinceIso) as unknown as Array<{ project_id: string; n: number; d: number }>;
    return new Map(rows.map((r) => [r.project_id, r.n + r.d * 0.1]));
  }

  recentEvents(limit = 50): Update[] {
    const rows = this.db
      .prepare('SELECT * FROM events ORDER BY ts DESC LIMIT ?')
      .all(limit) as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToUpdate);
  }

  // ---------- plans ----------

  upsertPlan(row: PlanRow): void {
    this.db
      .prepare(
        `INSERT INTO plans (date, status, generated_by, generated_at, updated_at, summary, json, file_mtime)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(date) DO UPDATE SET
           status=excluded.status, generated_by=excluded.generated_by,
           generated_at=excluded.generated_at, updated_at=excluded.updated_at,
           summary=excluded.summary, json=excluded.json, file_mtime=excluded.file_mtime`,
      )
      .run(
        row.date,
        row.status,
        row.generated_by,
        row.generated_at,
        row.updated_at,
        row.summary,
        row.json,
        row.file_mtime,
      );
  }

  getPlan(date: string): PlanRow | null {
    const row = this.db.prepare('SELECT * FROM plans WHERE date = ?').get(date);
    return (row as unknown as PlanRow) ?? null;
  }

  listPlanDates(limit = 60): string[] {
    const rows = this.db
      .prepare('SELECT date FROM plans ORDER BY date DESC LIMIT ?')
      .all(limit) as unknown as Array<{ date: string }>;
    return rows.map((r) => r.date);
  }

  // ---------- meta ----------

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
}

/**
 * 事件写入语句。
 * 单条插入与整项目重建共用一份——之前两处各写一份，加列时漏改一处就报
 * "column index out of range"，且只在重建索引时才暴露。
 */
const EVENT_UPSERT = `INSERT OR REPLACE INTO events
  (id, project_id, ts, source, type, content, delta, version, actor, refs, auto)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`;

/** 事件写入 SQLite 的参数顺序（必须与 EVENT_UPSERT 的列顺序一致） */
function eventParams(e: Update): Array<string | number | null> {
  return [
    e.id,
    e.project_id,
    e.ts,
    e.source,
    e.type,
    e.content,
    e.delta ?? null,
    e.version ?? null,
    e.actor ?? null,
    e.refs ? JSON.stringify(e.refs) : null,
    e.auto ? 1 : 0,
  ];
}

function rowToUpdate(row: Record<string, unknown>): Update {
  const auto = Number(row.auto ?? 0) === 1;
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    ts: toUtcIso(String(row.ts)),
    source: String(row.source) as Update['source'],
    type: String(row.type) as Update['type'],
    content: String(row.content ?? ''),
    delta: row.delta === null || row.delta === undefined ? undefined : Number(row.delta),
    version: row.version === null || row.version === undefined ? undefined : String(row.version),
    actor: row.actor === null || row.actor === undefined ? undefined : String(row.actor),
    refs: row.refs ? (JSON.parse(String(row.refs)) as Record<string, string>) : undefined,
    ...(auto ? { auto: true } : {}),
  };
}
