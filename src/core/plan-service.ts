import { emitEvent } from './events.ts';
import type { ProjectService } from './project-service.ts';
import type { Store } from '../store/repo.ts';
import type { DailyPlan, ProjectView, SourceKind, Task, UpdateType } from './types.ts';
import { newId, nowIso, todayStr } from './utils.ts';

export interface GeneratePlanOptions {
  date?: string;
  maxTasks?: number;
  source?: SourceKind;
  actor?: string;
  /** 覆盖既有未完成任务（默认保留） */
  replace?: boolean;
  focus?: string;
}

interface Candidate {
  task: Task;
  score: number;
  reason: string;
}

/**
 * 每日计划：读取所有项目的进展与规划，产出「今天做什么 + 为什么」。
 * 生成逻辑是确定性的（可解释、可复现），LLM 负责的是取舍与外层判断。
 */
export class PlanService {
  constructor(
    private readonly store: Store,
    private readonly projects: ProjectService,
  ) {}

  get(date?: string): DailyPlan | null {
    return this.store.readPlan(date ?? todayStr());
  }

  listDates(limit = 60): string[] {
    return this.store.listPlanDates(limit);
  }

  generate(opts: GeneratePlanOptions = {}): { plan: DailyPlan; candidates: number } {
    const date = opts.date ?? todayStr();
    const cfg = this.store.config;
    const maxTasks = opts.maxTasks ?? cfg.planning.maxTasksPerDay;
    const source = opts.source ?? 'agent';
    const existing = this.store.readPlan(date);

    const candidates = this.buildCandidates(this.projects.list({ include_archived: false }));

    const kept: Task[] = existing
      ? existing.tasks.filter((t) => t.status === 'done' || t.source === 'user')
      : [];
    if (opts.replace) kept.length = 0;

    const keptKeys = new Set(kept.map((t) => taskKey(t)));
    const perProject = new Map<string, number>();
    for (const t of kept) {
      if (t.project_id) perProject.set(t.project_id, (perProject.get(t.project_id) ?? 0) + 1);
    }

    const picked: Task[] = [];
    for (const c of candidates) {
      if (picked.length + kept.length >= maxTasks) break;
      if (keptKeys.has(taskKey(c.task))) continue;
      const pid = c.task.project_id ?? '_';
      if ((perProject.get(pid) ?? 0) >= 2) continue;
      perProject.set(pid, (perProject.get(pid) ?? 0) + 1);
      picked.push({ ...c.task, rationale: c.reason });
    }

    const tasks = [...kept, ...picked];
    const plan: DailyPlan = {
      date,
      status: existing?.status === 'active' ? 'active' : 'proposed',
      generated_by: source,
      generated_at: nowIso(),
      updated_at: nowIso(),
      summary: this.buildSummary(date, candidates, tasks, opts.focus),
      tasks,
      body: existing?.body?.trim() && existing.body.includes('## 备注')
        ? existing.body
        : '## 备注\n\n',
    };
    this.store.writePlan(plan);
    return { plan, candidates: candidates.length };
  }

  setTasks(date: string, tasks: Task[], source: SourceKind = 'user'): DailyPlan {
    const plan = this.store.readPlan(date) ?? this.emptyPlan(date, source);
    plan.tasks = tasks;
    plan.updated_at = nowIso();
    this.store.writePlan(plan);
    return plan;
  }

  addTask(date: string, task: Omit<Task, 'id' | 'updated_at'> & { id?: string }): DailyPlan {
    const plan = this.store.readPlan(date) ?? this.emptyPlan(date, task.source ?? 'user');
    plan.tasks.push({ id: task.id ?? newId('t'), updated_at: nowIso(), ...task });
    plan.updated_at = nowIso();
    this.store.writePlan(plan);
    return plan;
  }

  updateTask(
    date: string,
    taskId: string,
    patch: Partial<Pick<Task, 'title' | 'status' | 'estimate' | 'rationale' | 'project_id'>>,
  ): DailyPlan {
    const plan = this.requirePlan(date);
    const task = plan.tasks.find((t) => t.id === taskId || t.title === taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    Object.assign(task, patch, { updated_at: nowIso() });
    plan.updated_at = nowIso();
    this.store.writePlan(plan);
    return plan;
  }

  /**
   * 完成任务：勾选的同时回写项目事件流，形成
   * 「生成计划 → 执行 → 自动汇报进展」的闭环。
   */
  completeTask(
    date: string,
    taskId: string,
    opts: { note?: string; progress?: number; delta?: number; actor?: string; type?: UpdateType } = {},
  ): { plan: DailyPlan; task: Task } {
    const plan = this.requirePlan(date);
    const task = plan.tasks.find((t) => t.id === taskId || t.title === taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    task.status = 'done';
    task.updated_at = nowIso();
    plan.updated_at = nowIso();
    this.store.writePlan(plan);

    if (task.project_id) {
      this.projects.reportProgress(task.project_id, {
        content: opts.note ?? `完成计划任务：${task.title}`,
        progress: opts.progress,
        delta: opts.delta,
        type: opts.type ?? 'progress',
        source: 'agent',
        actor: opts.actor,
        refs: { plan_date: date, task_id: task.id },
        // 只有调用方写了说明才算叙述；否则是系统拼的占位文案，不作为合并宿主
        ...(opts.note ? {} : { auto: true }),
      });
    }
    return { plan, task };
  }

  setStatus(date: string, status: DailyPlan['status']): DailyPlan {
    const plan = this.requirePlan(date);
    plan.status = status;
    plan.updated_at = nowIso();
    this.store.writePlan(plan);
    emitEvent({ kind: 'plan.written', date, at: plan.updated_at });
    return plan;
  }

  /** 当日/指定日的可读简报，供 agent 直接注入上下文 */
  brief(date?: string): string {
    const d = date ?? todayStr();
    const plan = this.store.readPlan(d);
    const summary = this.projects.summary();
    const lines: string[] = [`# ${d} 项目简报`, ''];
    lines.push(
      `在做 ${summary.totals.active} 个 / 共 ${summary.totals.projects} 个项目，平均进度 ${summary.totals.avg_progress}%`,
    );
    if (summary.at_risk.length) {
      lines.push('', '## 风险');
      for (const r of summary.at_risk) lines.push(`- [${r.id}] ${r.name}：${r.reason}`);
    }
    if (summary.stale.length) {
      lines.push('', '## 滞涨');
      for (const s of summary.stale) lines.push(`- [${s.id}] ${s.name}：${s.days_since_activity} 天无进展`);
    }
    if (plan && plan.tasks.length) {
      lines.push('', `## 今日计划（${plan.status}）`);
      for (const t of plan.tasks) {
        const box = t.status === 'done' ? 'x' : t.status === 'doing' ? '~' : ' ';
        lines.push(`- [${box}] ${t.title}${t.project_id ? ` (@${t.project_id})` : ''}`);
        if (t.rationale) lines.push(`      ↳ ${t.rationale}`);
      }
    } else {
      lines.push('', '## 今日计划', '（尚未生成，可调用 pm_generate_daily_plan）');
    }
    return lines.join('\n');
  }

  // ------------------------------------------------------------------ 内部

  /**
   * 候选任务的推导依据只有一件事：**后续计划**。
   *
   * 不再看进度、截止、里程碑滑期——那些信号的前提是先维护好排期，
   * 对"写自用小工具"的场景既不准确也不产生行动。
   * 每个项目恰好产出一条与计划相关的候选：
   *   ① 计划停滞（有想做的事却很久没动）—— 最优先
   *   ② 有标记为「进行中」的计划 —— 直接推进
   *   ③ 有计划但都停在「计划中」—— 把它挪到进行中
   *   ④ 完全没有计划 —— 元任务：先想清楚下一步
   */
  private buildCandidates(projects: ProjectView[]): Candidate[] {
    const stalledAfter = this.store.config.reminders.planStalledAfterDays;
    const cands: Candidate[] = [];

    for (const p of projects) {
      const priorityBonus = { P0: 15, P1: 8, P2: 0, P3: -6 }[p.priority] ?? 0;
      const open = p.roadmap.filter((r) => r.status !== 'done' && r.status !== 'dropped');
      const inProgress = open.find((r) => r.status === 'in_progress');
      const idle = p.days_since_activity;

      if (open.length && idle > stalledAfter) {
        const focus = inProgress ?? open[0]!;
        cands.push({
          task: {
            id: newId('t'),
            project_id: p.id,
            title: `推进或重新思考「${focus.title}」（停滞 ${idle} 天）`,
            status: 'todo',
            source: 'agent',
            estimate: '1h',
          },
          score: 90 + Math.min(30, idle) + priorityBonus,
          reason: `「${p.name}」的后续计划已经 ${idle} 天没有动静`,
        });
        continue;
      }

      if (inProgress) {
        cands.push({
          task: {
            id: newId('t'),
            project_id: p.id,
            title: `推进「${inProgress.title}」（${p.name}）`,
            status: 'todo',
            source: 'agent',
            estimate: '2h',
          },
          score: 60 + priorityBonus + p.momentum * 0.5,
          reason: '这是你标记为「进行中」的下一步',
        });
        continue;
      }

      if (open.length) {
        const next = open[0]!;
        cands.push({
          task: {
            id: newId('t'),
            project_id: p.id,
            title: `开始「${next.title}」（${p.name}）`,
            status: 'todo',
            source: 'agent',
            estimate: '2h',
          },
          score: 40 + priorityBonus,
          reason: '计划都还停在「计划中」，挑一条挪到「进行中」',
        });
        continue;
      }

      if (p.status === 'active') {
        cands.push({
          task: {
            id: newId('t'),
            project_id: p.id,
            title: `为「${p.name}」写下下一步打算做什么`,
            status: 'todo',
            source: 'agent',
            estimate: '15m',
          },
          score: 30 + priorityBonus,
          reason: '没有任何未完成的后续计划，推导不出具体动作',
        });
      }
    }

    return cands.sort((a, b) => b.score - a.score);
  }

  private buildSummary(
    date: string,
    candidates: Candidate[],
    tasks: Task[],
    focus?: string,
  ): string {
    if (!tasks.length) return '暂无待办：各项目的后续计划都在推进中。';
    const projects = new Set(tasks.map((t) => t.project_id).filter(Boolean));
    const parts = [`${date} 共 ${tasks.length} 项，覆盖 ${projects.size} 个项目`];
    if (focus) parts.push(`聚焦：${focus}`);
    const stalled = candidates.filter((c) => c.score >= 90).length;
    if (stalled) parts.push(`其中 ${stalled} 项属于停滞较久的计划，建议优先处理`);
    return parts.join('；');
  }

  private emptyPlan(date: string, source: SourceKind): DailyPlan {
    return {
      date,
      status: 'proposed',
      generated_by: source,
      generated_at: nowIso(),
      updated_at: nowIso(),
      summary: '',
      tasks: [],
      body: '## 备注\n\n',
    };
  }

  private requirePlan(date: string): DailyPlan {
    const plan = this.store.readPlan(date);
    if (!plan) throw new Error(`当天计划不存在: ${date}，先调用 pm_generate_daily_plan`);
    return plan;
  }
}

function taskKey(t: Task): string {
  return `${t.project_id ?? '_'}::${t.title}`;
}
