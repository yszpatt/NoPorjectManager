export type Health = 'on_track' | 'at_risk' | 'stale' | 'blocked' | 'done' | 'unknown';
export type Status =
  | 'idea'
  | 'planning'
  | 'active'
  | 'blocked'
  | 'paused'
  | 'done'
  | 'archived';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type Source = 'agent' | 'user' | 'git' | 'integration';
export type TaskStatus = 'todo' | 'doing' | 'done';

export interface LastUpdate {
  source: Source;
  type: string;
  ts: string;
  content: string;
}

export interface ReleaseInfo {
  version: string;
  /** 发布时间（ISO UTC） */
  date: string;
  note?: string;
  tag?: string;
  commit?: string;
  url?: string;
}

export type ReminderKind = 'plan_stalled' | 'no_plan';

/** 提醒项：只关心「有想做的事，是不是很久没动了」 */
export interface Reminder {
  project_id: string;
  project: string;
  level: 'high' | 'medium' | 'low';
  kind: ReminderKind;
  detail: string;
  suggestion: string;
}

/**
 * 看板卡片。
 * 前六个字段是卡片的信息主体（发布 / 计划 / 思考）；
 * 后半部分（progress、target_date、goals）保留给详情页与 Agent，卡片不展示。
 */
export interface Card {
  id: string;
  name: string;
  description: string;
  status: Status;
  priority: Priority;
  tags: string[];
  health: Health;
  health_reason: string;
  momentum: number;
  event_count: number;
  days_since_activity: number;
  updated_at: string;
  /** 最近一次发布；从未发布为 null */
  last_release: ReleaseInfo | null;
  release_count: number;
  /** 后续计划：最近一项未完成项（不要求有日期）+ 其余数量 */
  next_plan: { title: string; due?: string; remaining: number } | null;
  /** 最近一条思考/记录 */
  last_update: LastUpdate | null;
  /** 计划停滞提醒；没有命中为 null */
  reminder: Reminder | null;
  /** 以下不在卡片上展示 */
  progress: number;
  progress_derived: boolean;
  target_date: string | null;
  days_to_target: number | null;
  goals: Goal[];
  open_goals: number;
}

/** 已并入某条记录的提交 */
export interface LinkedCommit {
  sha: string;
  /** 原始提交标题 */
  subject?: string;
}

/** 跨项目动态流的一条记录 */
export interface FeedEntry {
  id: string;
  project_id: string;
  project_name: string;
  project_status: Status;
  ts: string;
  source: Source;
  type: UpdateType;
  content: string;
  delta?: number;
  version?: string;
  actor?: string;
  refs?: Record<string, string>;
  /** 并入本条记录的提交（原本单独的 git 记录不再出现） */
  commits?: LinkedCommit[];
}

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
  status: 'planned' | 'in_progress' | 'done' | 'dropped';
  description?: string;
}

export interface RepoRef {
  path?: string;
  url?: string;
  branch?: string;
}

export type UpdateType =
  | 'progress'
  | 'status'
  | 'note'
  | 'milestone'
  | 'blocker'
  | 'plan'
  | 'release';

export interface TimelineEntry {
  ts: string;
  source: Source;
  type: UpdateType;
  content: string;
  delta?: number;
  version?: string;
  actor?: string;
  refs?: Record<string, string>;
  commits?: LinkedCommit[];
}

export interface ProjectDetail extends Omit<Card, 'last_update'> {
  body: string;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  goals: Goal[];
  roadmap: RoadmapItem[];
  repos: RepoRef[];
  custom: Record<string, unknown>;
  timeline: TimelineEntry[];
  /** 发布历史，由事件流倒推 */
  releases: ReleaseInfo[];
}

/** `/api/projects?detail=full` 的返回结构：含规划与目标，不含正文与时间线 */
export type ProjectFull = Omit<ProjectDetail, 'timeline' | 'body'>;

export interface Summary {
  generated_at: string;
  totals: { projects: number; active: number; archived: number; avg_progress: number };
  by_status: Record<string, number>;
  by_health: Record<string, number>;
  at_risk: Array<{ id: string; name: string; reason: string; progress: number; target_date?: string }>;
  stale: Array<{ id: string; name: string; days_since_activity: number }>;
  blocked: Array<{ id: string; name: string }>;
  upcoming: Array<{
    id: string;
    name: string;
    target_date: string;
    days_left: number;
    progress: number;
  }>;
  today_plan: { date: string; status: string; open_tasks: number; total_tasks: number } | null;
}

export interface RiskItem {
  project_id: string;
  project: string;
  level: 'high' | 'medium' | 'low';
  kind: string;
  detail: string;
  suggestion: string;
}

export interface Task {
  id: string;
  project_id?: string;
  title: string;
  status: TaskStatus;
  estimate?: string;
  source: Source;
  rationale?: string;
  updated_at?: string;
}

export interface Plan {
  date: string;
  status: 'proposed' | 'active' | 'closed' | 'none';
  generated_by?: Source;
  summary: string;
  tasks: Task[];
}
