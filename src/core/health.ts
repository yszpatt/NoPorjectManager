import type { PMConfig } from '../store/config.ts';
import type { Health, Project, Update } from './types.ts';
import { clamp, daysBetween, localDateStr, round1, todayStr } from './utils.ts';

export interface HealthResult {
  health: Health;
  reason: string;
  last_activity_at: string;
  days_since_activity: number;
  days_to_target: number | null;
  momentum: number;
  /** 时间轴预期进度（按 created→target 线性推进），无 deadline 时为 null */
  expected_progress: number | null;
}

const TERMINAL: ReadonlySet<string> = new Set(['done', 'archived']);

/**
 * 按路线图里程碑完成度推导进度。
 * 用于 `progress.mode = 'auto'`：只需维护里程碑状态，进度自动跟随。
 *
 * 权重：已完成 = 1，进行中 = 0.5，计划中 = 0（已放弃不计入分母）。
 * 只数"已完成"会让有多个里程碑的项目长期显示 0%，过于失真。
 * 没有可用里程碑时回退到人工声明的值，避免项目凭空变成 0%。
 */
export function derivedProgress(p: Project): { value: number; based: 'milestones' | 'declared' } {
  const items = p.roadmap.filter((r) => r.status !== 'dropped');
  if (!items.length) return { value: p.progress, based: 'declared' };
  const credit = items.reduce(
    (sum, r) => sum + (r.status === 'done' ? 1 : r.status === 'in_progress' ? 0.5 : 0),
    0,
  );
  return { value: Math.round((credit / items.length) * 100), based: 'milestones' };
}

/** 由「项目事实 + 事件流」派生健康度，不落盘为事实，仅进索引。 */
export function evaluateHealth(
  project: Project,
  events: Update[],
  config: PMConfig,
  today: string = todayStr(),
): HealthResult {
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const latestEvent = sorted[0]?.ts ?? null;
  const lastActivity = maxIso(project.updated_at, latestEvent, project.created_at);
  // 用本地日期而非 UTC 日期，否则 +08:00 早上发生的事会被算成"1 天前"
  const daysSinceActivity = daysBetween(today, localDateStr(lastActivity));

  const since = new Date(Date.now() - 14 * 86400_000).toISOString();
  const recent = sorted.filter((e) => e.ts >= since);
  const momentum = round1(
    recent.length + recent.reduce((acc, e) => acc + Math.abs(e.delta ?? 0) * 0.1, 0),
  );

  let daysToTarget: number | null = null;
  let expected: number | null = null;
  if (project.target_date) {
    daysToTarget = daysBetween(project.target_date, today);
    const createdLocal = localDateStr(project.created_at);
    const total = Math.max(1, daysBetween(project.target_date, createdLocal));
    const elapsed = clamp(daysBetween(today, createdLocal), 0, total);
    expected = round1((elapsed / total) * 100);
  }

  const base = {
    last_activity_at: lastActivity,
    days_since_activity: daysSinceActivity,
    days_to_target: daysToTarget,
    momentum,
    expected_progress: expected,
  };

  if (TERMINAL.has(project.status)) {
    return { ...base, health: 'done', reason: '项目已收尾' };
  }
  if (project.status === 'blocked') {
    return { ...base, health: 'blocked', reason: '项目处于阻塞状态' };
  }
  if (
    project.status !== 'idea' &&
    project.status !== 'planning' &&
    daysSinceActivity > config.health.staleAfterDays
  ) {
    return {
      ...base,
      health: 'stale',
      reason: `已 ${daysSinceActivity} 天无任何进展记录（阈值 ${config.health.staleAfterDays} 天）`,
    };
  }
  if (project.status === 'paused') {
    return { ...base, health: 'stale', reason: '项目已暂停' };
  }
  if (expected !== null && project.progress + config.health.atRiskProgressGap < expected) {
    const overdue = (daysToTarget ?? 0) < 0 ? '已逾期，' : '';
    return {
      ...base,
      health: 'at_risk',
      reason: `${overdue}进度 ${project.progress}% 落后于时间轴预期 ${expected}%`,
    };
  }
  if (project.progress === 0 && project.status === 'active') {
    return { ...base, health: 'unknown', reason: '已激活但尚无进度记录' };
  }
  return { ...base, health: 'on_track', reason: '进度与时间轴基本匹配' };
}

function maxIso(...values: Array<string | null | undefined>): string {
  let best = '';
  for (const v of values) {
    if (v && v > best) best = v;
  }
  return best || new Date().toISOString();
}
