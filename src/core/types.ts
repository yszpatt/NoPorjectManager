/**
 * 领域类型定义。所有存储与适配器都围绕这些类型工作。
 */

export type ProjectStatus =
  | 'idea'
  | 'planning'
  | 'active'
  | 'blocked'
  | 'paused'
  | 'done'
  | 'archived';

export type Health = 'on_track' | 'at_risk' | 'stale' | 'blocked' | 'done' | 'unknown';

export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

/** 数据来源：agent(MCP) / user(看板) / git(采集) / integration(未来接入的外部系统) */
export type SourceKind = 'agent' | 'user' | 'git' | 'integration';

export type UpdateType =
  | 'progress'
  | 'status'
  | 'note'
  | 'milestone'
  | 'blocker'
  | 'plan'
  /** 发布了某个版本 —— 独立开发场景下这是一等公民的记录 */
  | 'release';

export type RoadmapStatus = 'planned' | 'in_progress' | 'done' | 'dropped';

export type TaskStatus = 'todo' | 'doing' | 'done';

export interface Goal {
  id: string;
  title: string;
  metric?: string;
  target?: number;
  current?: number;
  due?: string;
  status?: 'open' | 'done' | 'dropped';
}

export interface RoadmapItem {
  id: string;
  title: string;
  due?: string;
  status: RoadmapStatus;
  description?: string;
}

export interface RepoRef {
  path?: string;
  url?: string;
  branch?: string;
}

/** 追加型事件，项目时间线与健康度的唯一依据 */
export interface Update {
  id: string;
  project_id: string;
  ts: string;
  source: SourceKind;
  type: UpdateType;
  content: string;
  /** 进度增量，仅在 type=progress 时有意义 */
  delta?: number;
  /** 版本号，仅在 type=release 时有意义（如 v0.3.2） */
  version?: string;
  actor?: string;
  refs?: Record<string, string>;
  /**
   * 系统自动生成的审计事件（`状态 a → b`、`进度 x% → y%`）。
   * 它们不承载叙述，因此不参与「提交 ↔ 汇报」的自动合并——否则会把提交并到一句机器文案上。
   */
  auto?: boolean;
}

/** 从事件流派生出的发布信息 */
export interface ReleaseInfo {
  version: string;
  /** 发布时间（ISO，UTC） */
  date: string;
  note?: string;
  tag?: string;
  commit?: string;
  url?: string;
}

/** 事实源中持久化的项目结构 */
export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  /** 权威进度 0-100，由人或 agent 显式声明 */
  progress: number;
  priority: Priority;
  tags: string[];
  repos: RepoRef[];
  target_date?: string;
  created_at: string;
  updated_at: string;
  goals: Goal[];
  roadmap: RoadmapItem[];
  custom: Record<string, unknown>;
  /** Markdown 正文（介绍等） */
  body: string;
}

/** 派生字段，由事件流计算，不落盘 */
export interface ProjectView extends Project {
  last_activity_at: string;
  event_count: number;
  /** 近 14 天事件数加权，反映推进速度 */
  momentum: number;
  /** progress 是否由里程碑自动推导（对应 config.progress.mode = auto） */
  progress_derived: boolean;
  /** 最近一次发布；从未发布为 null */
  last_release: ReleaseInfo | null;
  /** 累计发布次数 */
  release_count: number;
  days_since_activity: number;
  days_to_target: number | null;
  health: Health;
  health_reason: string;
}

export interface ProjectFilter {
  status?: ProjectStatus[];
  health?: Health[];
  tags?: string[];
  priority?: Priority[];
  query?: string;
  include_archived?: boolean;
  limit?: number;
}

export interface Task {
  id: string;
  project_id?: string;
  title: string;
  status: TaskStatus;
  estimate?: string;
  source: SourceKind;
  rationale?: string;
  updated_at?: string;
}

export interface DailyPlan {
  date: string;
  status: 'proposed' | 'active' | 'closed';
  generated_by: SourceKind;
  generated_at: string;
  updated_at: string;
  summary: string;
  tasks: Task[];
  body: string;
}

export interface Summary {
  generated_at: string;
  totals: {
    projects: number;
    active: number;
    archived: number;
    avg_progress: number;
  };
  by_status: Record<string, number>;
  by_health: Record<string, number>;
  at_risk: Array<{ id: string; name: string; reason: string; progress: number; target_date?: string }>;
  stale: Array<{ id: string; name: string; days_since_activity: number }>;
  blocked: Array<{ id: string; name: string }>;
  upcoming: Array<{ id: string; name: string; target_date: string; days_left: number; progress: number }>;
  today_plan?: { date: string; status: string; open_tasks: number; total_tasks: number } | null;
}

/**
 * 提醒项。
 * 独立开发场景下，真正值得打断你的不是"进度落后于排期"，
 * 而是"有明确想做的事，但很久没动了"。
 */
export interface RiskItem {
  project_id: string;
  project: string;
  level: 'high' | 'medium' | 'low';
  kind: 'plan_stalled' | 'no_plan';
  detail: string;
  suggestion: string;
}

/** 跨项目动态流中的一条记录 */
export interface FeedEntry {
  project_id: string;
  project_name: string;
  project_status: ProjectStatus;
  ts: string;
  source: SourceKind;
  type: UpdateType;
  content: string;
  delta?: number;
  version?: string;
  actor?: string;
  refs?: Record<string, string>;
}
