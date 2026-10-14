import type { Health, Priority, Source, Status } from '../types';

/* ------------------------------------------------------------------ 时间 */

export function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  const min = Math.round(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天前`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} 个月前`;
  return `${Math.round(mo / 12)} 年前`;
}

/**
 * 取时间戳在「本地时区」下的日期。
 * 事件时间是 UTC，直接 slice(0,10) 会把 +08:00 的早晨算到前一天。
 */
export function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fmtDate(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function daysLabel(days: number | null | undefined): string {
  if (days === null || days === undefined) return '—';
  if (days === 0) return '今天截止';
  if (days < 0) return `逾期 ${-days} 天`;
  return `剩 ${days} 天`;
}

export function deadlineTone(days: number | null | undefined): 'danger' | 'warn' | 'muted' {
  if (days === null || days === undefined) return 'muted';
  if (days < 0) return 'danger';
  if (days <= 7) return 'warn';
  return 'muted';
}

/* ------------------------------------------------------------------ 元数据 */

export interface Meta {
  label: string;
  /** 文本色 */
  text: string;
  /** 点/条背景色 */
  bg: string;
  /** 柔和底色（标签用） */
  soft: string;
}

export const HEALTH_META: Record<Health, Meta> = {
  on_track: { label: '正常', text: 'text-ok', bg: 'bg-ok', soft: 'bg-ok/12' },
  at_risk: { label: '风险', text: 'text-warn', bg: 'bg-warn', soft: 'bg-warn/15' },
  stale: { label: '滞涨', text: 'text-idle', bg: 'bg-idle', soft: 'bg-idle/15' },
  blocked: { label: '阻塞', text: 'text-danger', bg: 'bg-danger', soft: 'bg-danger/12' },
  done: { label: '收尾', text: 'text-info', bg: 'bg-info', soft: 'bg-info/12' },
  unknown: { label: '未知', text: 'text-ink-mute', bg: 'bg-ink-mute', soft: 'bg-ink-mute/15' },
};

export const STATUS_META: Record<Status, Meta> = {
  idea: { label: '想法', text: 'text-idle', bg: 'bg-idle', soft: 'bg-idle/12' },
  planning: { label: '规划中', text: 'text-info', bg: 'bg-info', soft: 'bg-info/12' },
  active: { label: '进行中', text: 'text-accent', bg: 'bg-accent', soft: 'bg-accent/12' },
  blocked: { label: '阻塞', text: 'text-danger', bg: 'bg-danger', soft: 'bg-danger/12' },
  paused: { label: '已暂停', text: 'text-idle', bg: 'bg-idle', soft: 'bg-idle/12' },
  done: { label: '已完成', text: 'text-ok', bg: 'bg-ok', soft: 'bg-ok/12' },
  archived: { label: '已归档', text: 'text-ink-mute', bg: 'bg-ink-mute', soft: 'bg-ink-mute/12' },
};

export const PRIORITY_META: Record<Priority, Meta> = {
  P0: { label: 'P0', text: 'text-danger', bg: 'bg-danger', soft: 'bg-danger/12' },
  P1: { label: 'P1', text: 'text-warn', bg: 'bg-warn', soft: 'bg-warn/15' },
  P2: { label: 'P2', text: 'text-ink-soft', bg: 'bg-ink-soft', soft: 'bg-ink-soft/12' },
  P3: { label: 'P3', text: 'text-ink-mute', bg: 'bg-ink-mute', soft: 'bg-ink-mute/12' },
};

export const SOURCE_META: Record<Source, { label: string; text: string; soft: string }> = {
  agent: { label: 'Agent', text: 'text-accent', soft: 'bg-accent/12' },
  user: { label: '人工', text: 'text-info', soft: 'bg-info/12' },
  git: { label: 'Git', text: 'text-ok', soft: 'bg-ok/12' },
  integration: { label: '外部', text: 'text-warn', soft: 'bg-warn/15' },
};

export const RISK_LEVEL_META = {
  high: { label: '高', text: 'text-danger', soft: 'bg-danger/12' },
  medium: { label: '中', text: 'text-warn', soft: 'bg-warn/15' },
  low: { label: '低', text: 'text-ink-soft', soft: 'bg-ink-soft/12' },
} as const;

export const RISK_KIND_LABEL: Record<string, string> = {
  blocked: '阻塞',
  stale: '滞涨',
  behind_schedule: '进度落后',
  slipping_milestone: '里程碑滑期',
  goal_off_track: '目标失焦',
  no_roadmap: '缺少规划',
};

export const ROADMAP_STATUS_LABEL: Record<string, string> = {
  planned: '计划中',
  in_progress: '进行中',
  done: '已完成',
  dropped: '已放弃',
};

/** 优先级用卡片左侧色条表达，比徽章安静得多 */
export const PRIORITY_TONE: Record<Priority, string> = {
  P0: 'var(--color-danger)',
  P1: 'var(--color-warn)',
  P2: 'var(--color-line-strong)',
  P3: 'var(--color-line)',
};

/** 提醒的展示色（等级越高越靠前） */
export const REMINDER_LEVEL_CLASS: Record<'high' | 'medium' | 'low', string> = {
  high: 'text-danger',
  medium: 'text-warn',
  low: 'text-ink-mute',
};

/** 提醒强度排序：看板与表格共用 */
export function reminderRank(r: { level: 'high' | 'medium' | 'low' } | null): number {
  if (!r) return 0;
  return r.level === 'high' ? 3 : r.level === 'medium' ? 2 : 1;
}

/** 事件类型的中文标签与配色，用于动态流 */
export const UPDATE_TYPE_LABEL: Record<string, string> = {
  release: '发布',
  note: '思考',
  plan: '计划',
  status: '状态',
  progress: '进展',
  milestone: '里程碑',
  blocker: '阻塞',
};

export const UPDATE_TYPE_CLASS: Record<string, string> = {
  release: 'bg-ok/12 text-ok',
  note: 'bg-accent/12 text-accent',
  plan: 'bg-info/12 text-info',
  blocker: 'bg-danger/12 text-danger',
  status: 'bg-surface-2 text-ink-soft',
  progress: 'bg-surface-2 text-ink-soft',
  milestone: 'bg-surface-2 text-ink-soft',
};

/** 发布距今多久的措辞 */
export function releaseAge(iso: string): string {
  return relTime(iso);
}

/** 进度环等 SVG 需要具体的颜色值，这里映射到 CSS 变量 */
export const HEALTH_TONE: Record<Health, string> = {
  on_track: 'var(--color-accent)',
  at_risk: 'var(--color-warn)',
  stale: 'var(--color-idle)',
  blocked: 'var(--color-danger)',
  done: 'var(--color-info)',
  unknown: 'var(--color-ink-mute)',
};

/** 看板列顺序与可见性 */
export const BOARD_COLUMNS: Status[] = ['idea', 'planning', 'active', 'blocked', 'paused', 'done'];

/** 项目按健康度排序的权重（越小越靠前） */
export function healthRank(h: Health): number {
  return { blocked: 0, at_risk: 1, stale: 2, unknown: 3, on_track: 4, done: 5 }[h] ?? 6;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
