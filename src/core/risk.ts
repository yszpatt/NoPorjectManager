import type { ProjectService } from './project-service.ts';
import type { ProjectView, RiskItem } from './types.ts';

/**
 * 提醒引擎。
 *
 * 只回答一个问题：**有明确想做的事，是不是很久没动了？**
 *
 * 进度落后、截止临近、里程碑滑期这类信号，前提是先维护好排期；
 * 对"写自用小工具"的场景来说，它们既不准确也不催生行动，
 * 所以这里一律不产生提醒——只保留「计划停滞」这一种。
 */
export function analyzeRisks(service: ProjectService, stalledAfterDays: number): RiskItem[] {
  const out: RiskItem[] = [];
  for (const p of service.list({ include_archived: false })) {
    const r = reminderOf(p, stalledAfterDays);
    if (r) out.push(r);
  }
  const order = { high: 0, medium: 1, low: 2 };
  return out.sort(
    (a, b) => order[a.level] - order[b.level] || b.detail.length - a.detail.length,
  );
}

/** 单个项目的提醒；没有命中返回 null。看板卡片与提醒列表共用这一份规则。 */
export function reminderOf(p: ProjectView, stalledAfterDays: number): RiskItem | null {
  const open = p.roadmap.filter((r) => r.status !== 'done' && r.status !== 'dropped');
  const base = { project_id: p.id, project: p.name };
  const idle = p.days_since_activity;

  if (!open.length) {
    // 没有下一步计划，且已经很久没记录 —— 大概率是被遗忘了
    if (p.status === 'active' && idle > stalledAfterDays) {
      return {
        ...base,
        level: 'low',
        kind: 'no_plan',
        detail: `已 ${idle} 天没有记录，也没有任何未完成的后续计划`,
        suggestion: '写下一条下一步打算做的事，哪怕只是「再想想」——没有计划的项目无法被推进',
      };
    }
    return null;
  }

  if (idle > stalledAfterDays) {
    const focus =
      open.find((r) => r.status === 'in_progress') ??
      [...open].filter((r) => r.due).sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''))[0] ??
      open[0]!;
    return {
      ...base,
      level: idle > 30 ? 'high' : 'medium',
      kind: 'plan_stalled',
      detail: `后续计划「${focus.title}」已停滞 ${idle} 天`,
      suggestion: '要么推进一步，要么把它改掉 —— 长期挂着的计划比没有计划更误导',
    };
  }

  return null;
}
