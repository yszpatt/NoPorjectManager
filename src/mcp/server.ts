import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { App } from '../app.ts';
import { analyzeRisks } from '../core/risk.ts';
import type { CreateProjectInput } from '../core/project-service.ts';
import type { ProjectFilter, ProjectStatus, ProjectView, UpdateType } from '../core/types.ts';
import { syncGit } from '../collectors/git.ts';
import { mergeConfig } from '../store/config.ts';

const STATUS = ['idea', 'planning', 'active', 'blocked', 'paused', 'done', 'archived'] as const;
const HEALTH = ['on_track', 'at_risk', 'stale', 'blocked', 'done', 'unknown'] as const;
const PRIORITY = ['P0', 'P1', 'P2', 'P3'] as const;
const UPDATE_TYPE = ['progress', 'status', 'note', 'milestone', 'blocker', 'plan'] as const;
const TASK_STATUS = ['todo', 'doing', 'done'] as const;

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: `错误：${message}` }], isError: true };
}

/** 包装处理器，统一错误为可读文本而非协议异常 */
function handler<A>(fn: (args: A) => unknown) {
  return (args: A): ToolResult => {
    try {
      return ok(fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/**
 * 写操作的回执：只回「改了什么」，不回显整个项目对象。
 *
 * 完整 ProjectView 有 2KB 以上，且随 roadmap / goals 数量线性增长；
 * Agent 每次写入都要为它付一遍上下文成本，而其中真正用得上的只有 id 与 progress。
 * 需要完整字段时显式调用 pm_get_project。
 */
function receipt(p: ProjectView, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: p.id,
    status: p.status,
    progress: p.progress,
    updated_at: p.updated_at,
    ...extra,
  };
}

/**
 * 构建 MCP Server：所有工具都在这里注册，
 * stdio 与 HTTP 两种传输共用同一份定义。
 */
export function createPmServer(app: App): McpServer {
  const { store, projects, plans } = app;

  const server = new McpServer(
    {
      name: 'project-manager',
      version: '0.1.0',
      title: '项目管理看板',
    },
    {
      instructions: [
        '本地项目看板：按「项目档案」组织，看重思考记录 / 后续计划 / 发布记录，进度与截止日期只是辅助字段。',
        '三个核心动作：',
        '1) 会话开始看今日计划（pm_get_daily_plan）；',
        '2) 想清楚下一步就 pm_upsert_roadmap_item —— 每日计划完全由它推导；',
        '3) 有想法/决策/进展就 pm_report_progress，已提交的改动带上 refs: { commit }，一件事只留一条记录。',
        '详细规范见 project-manager Skill。',
      ].join('\n'),
    },
  );

  // ------------------------------------------------------------------ 查询

  server.registerTool(
    'pm_list_projects',
    {
      title: '列出项目',
      description: '筛选项目。默认返回精简卡片，detail=full 返回完整字段。',
      inputSchema: {
        status: z.array(z.enum(STATUS)).optional(),
        health: z.array(z.enum(HEALTH)).optional(),
        priority: z.array(z.enum(PRIORITY)).optional(),
        tags: z.array(z.string()).optional(),
        query: z.string().optional().describe('匹配名称/描述/正文/标签'),
        include_archived: z.boolean().optional().default(false),
        limit: z.number().int().positive().optional(),
        detail: z.enum(['card', 'full']).optional().default('card'),
      },
      annotations: READ_ONLY,
    },
    handler((args: {
      status?: ProjectStatus[];
      health?: (typeof HEALTH)[number][];
      priority?: (typeof PRIORITY)[number][];
      tags?: string[];
      query?: string;
      include_archived: boolean;
      limit?: number;
      detail: 'card' | 'full';
    }) => {
      const filter: ProjectFilter = {
        status: args.status,
        health: args.health,
        priority: args.priority,
        tags: args.tags,
        query: args.query,
        include_archived: args.include_archived,
        limit: args.limit,
      };
      const list =
        args.detail === 'full'
          ? projects.list(filter).map((p) => ({ ...p, body: undefined }))
          : projects.cards(filter);
      return { count: list.length, projects: list };
    }),
  );

  server.registerTool(
    'pm_get_project',
    {
      title: '查看项目详情',
      description: '读取单个项目的完整信息，附带最近时间线。',
      inputSchema: {
        id: z.string(),
        timeline_limit: z
          .number()
          .int()
          .positive()
          .optional()
          .default(15)
          .describe('默认 15 条，回看更早历史时显式传大'),
      },
      annotations: READ_ONLY,
    },
    handler((args: { id: string; timeline_limit: number }) => {
      const p = projects.get(args.id, { timeline_limit: args.timeline_limit });
      if (!p) throw new Error(`项目不存在: ${args.id}`);
      return p;
    }),
  );

  server.registerTool(
    'pm_summary',
    {
      title: '全局汇总',
      description: '跨项目汇总：总数与状态/健康度分布、风险、滞涨、阻塞、临近截止，以及今日计划概况。',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    handler(() => projects.summary()),
  );

  server.registerTool(
    'pm_timeline',
    {
      title: '项目时间线',
      description: '读取某项目的进展事件流（含来源：agent/user/git/integration）。',
      inputSchema: {
        id: z.string(),
        limit: z.number().int().positive().optional().default(50),
      },
      annotations: READ_ONLY,
    },
    handler((args: { id: string; limit: number }) => ({
      project_id: args.id,
      events: projects.timeline(args.id, args.limit),
    })),
  );

  server.registerTool(
    'pm_brief',
    {
      title: '今日简报',
      description: '人类可读的当日简报（风险 + 滞涨 + 今日计划），适合直接注入上下文。',
      inputSchema: { date: z.string().optional().describe('默认今天') },
      annotations: READ_ONLY,
    },
    handler((args: { date?: string }) => plans.brief(args.date)),
  );

  server.registerTool(
    'pm_check_reminders',
    {
      title: '检查提醒',
      description:
        '「计划停滞」提醒：哪些项目有想做却没记的事。只看计划与记录活跃度，不涉及进度与排期。',
      inputSchema: {
        stalled_days: z.number().int().positive().optional().describe('默认取配置值'),
        min_level: z.enum(['high', 'medium', 'low']).optional().default('low'),
      },
      annotations: READ_ONLY,
    },
    handler((args: { stalled_days?: number; min_level: 'high' | 'medium' | 'low' }) => {
      const stalled = args.stalled_days ?? store.config.reminders.planStalledAfterDays;
      const rank = { high: 0, medium: 1, low: 2 };
      const reminders = analyzeRisks(projects, stalled).filter(
        (r) => rank[r.level] <= rank[args.min_level],
      );
      return { count: reminders.length, stalled_days: stalled, reminders };
    }),
  );

  server.registerTool(
    'pm_get_feed',
    {
      title: '跨项目动态流',
      description: '按时间倒序读取所有项目的记录，回答「最近都在忙什么」。可按项目或类型筛选。',
      inputSchema: {
        limit: z.number().int().positive().optional().default(30),
        project_id: z.string().optional(),
        types: z
          .array(z.enum(['progress', 'status', 'note', 'milestone', 'blocker', 'plan', 'release']))
          .optional(),
      },
      annotations: READ_ONLY,
    },
    handler((args: { limit: number; project_id?: string; types?: UpdateType[] }) =>
      projects.feed({ limit: args.limit, project_id: args.project_id, types: args.types }),
    ),
  );

  // ------------------------------------------------------------------ 项目增删改

  server.registerTool(
    'pm_create_project',
    {
      title: '创建项目',
      description:
        '新建项目。跨会话/跨仓库的项目都要在这里登记，才能被看板与每日计划覆盖。',
      inputSchema: {
        name: z.string(),
        description: z.string().optional(),
        id: z.string().optional().describe('建议显式指定（ASCII），默认由名称生成'),
        status: z.enum(STATUS).optional().default('idea'),
        progress: z.number().min(0).max(100).optional().default(0),
        priority: z.enum(PRIORITY).optional().default('P2'),
        tags: z.array(z.string()).optional(),
        target_date: z.string().optional(),
        goals: z
          .array(
            z.object({
              id: z.string().optional(),
              title: z.string(),
              metric: z.string().optional(),
              target: z.number().optional(),
              current: z.number().optional(),
              due: z.string().optional(),
              status: z.enum(['open', 'done', 'dropped']).optional(),
            }),
          )
          .optional(),
        roadmap: z
          .array(
            z.object({
              id: z.string().optional(),
              title: z.string(),
              due: z.string().optional(),
              status: z.enum(['planned', 'in_progress', 'done', 'dropped']).optional(),
              description: z.string().optional(),
            }),
          )
          .optional(),
        body: z.string().optional().describe('Markdown 正文'),
        repos: z
          .array(z.object({ path: z.string().optional(), url: z.string().optional(), branch: z.string().optional() }))
          .optional()
          .describe('关联本地仓库，用于采集 commit'),
        actor: z.string().optional(),
      },
      annotations: WRITE,
    },
    handler((args: {
      name: string;
      description?: string;
      id?: string;
      status: ProjectStatus;
      progress: number;
      priority: 'P0' | 'P1' | 'P2' | 'P3';
      tags?: string[];
      target_date?: string;
      goals?: NonNullable<CreateProjectInput['goals']>;
      roadmap?: NonNullable<CreateProjectInput['roadmap']>;
      body?: string;
      repos?: Array<{ path?: string; url?: string; branch?: string }>;
      actor?: string;
    }) => {
      const created = projects.create({
        id: args.id,
        name: args.name,
        description: args.description,
        status: args.status,
        progress: args.progress,
        priority: args.priority,
        tags: args.tags,
        target_date: args.target_date,
        goals: args.goals,
        roadmap: args.roadmap,
        body: args.body,
        source: 'agent',
        actor: args.actor,
      });
      for (const repo of args.repos ?? []) projects.linkRepo(created.id, repo);
      return receipt(created, { name: created.name, priority: created.priority });
    }),
  );

  server.registerTool(
    'pm_update_project',
    {
      title: '更新项目',
      description:
        '局部更新项目字段。status/progress 变更会自动写入时间线事件，无需重复调用 pm_report_progress。',
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        status: z.enum(STATUS).optional(),
        progress: z.number().min(0).max(100).optional(),
        priority: z.enum(PRIORITY).optional(),
        tags: z.array(z.string()).optional(),
        target_date: z.string().nullable().optional().describe('null 表示清除'),
        custom: z.record(z.unknown()).optional(),
        body: z.string().optional(),
        actor: z.string().optional(),
      },
      annotations: WRITE,
    },
    handler((args: Parameters<typeof projects.update>[1] & { id: string }) => {
      const { id, ...patch } = args;
      const p = projects.update(id, { ...patch, source: 'agent' });
      return receipt(p, { changed: Object.keys(patch).filter((k) => k !== 'actor') });
    }),
  );

  server.registerTool(
    'pm_delete_project',
    {
      title: '删除/归档项目',
      description: '默认归档（archived，保留历史）；hard=true 才会真正删除文件与事件。',
      inputSchema: {
        id: z.string(),
        hard: z.boolean().optional().default(false),
      },
      annotations: { ...WRITE, destructiveHint: true },
    },
    handler((args: { id: string; hard: boolean }) => projects.remove(args.id, args.hard)),
  );

  // ------------------------------------------------------------------ 进展与规划

  server.registerTool(
    'pm_report_progress',
    {
      title: '汇报进展',
      description:
        '追加一条进展事件，可同时修正进度。最常用的写入入口。progress 为绝对百分比，delta 为增量（progress 优先）。',
      inputSchema: {
        id: z.string(),
        content: z
          .string()
          .describe('首行结论，空行后分条列出，每条以 `完成`/`调整`/`修复`/`决策`/`卡点`/`问题` 开头'),
        type: z.enum(UPDATE_TYPE).optional().describe('默认按是否带进度自动判定'),
        progress: z.number().min(0).max(100).optional(),
        delta: z.number().optional().describe('如 +10 / -5'),
        actor: z.string().optional(),
        refs: z
          .record(z.string())
          .optional()
          .describe('已提交的改动必须带 commit（多个用 commits），看板据此并入 git 记录避免重复'),
      },
      annotations: WRITE,
    },
    handler((args: Parameters<typeof projects.reportProgress>[1] & { id: string }) =>
      receipt(projects.reportProgress(args.id, { ...args, source: 'agent' }), {
        event_type: args.type ?? 'progress',
      }),
    ),
  );

  server.registerTool(
    'pm_report_release',
    {
      title: '记录一次发布',
      description:
        '记录一个版本的发布，version 必填。仓库已关联时，规范的 git tag 会被 pm_sync_git 自动采集，不必手工记录。',
      inputSchema: {
        id: z.string(),
        version: z.string().describe('如 v0.3.2'),
        note: z.string().optional().describe('这次发布包含什么'),
        url: z.string().optional().describe('发布页链接'),
        tag: z.string().optional(),
        date: z.string().optional().describe('补录历史发布时使用'),
        actor: z.string().optional(),
      },
      annotations: WRITE,
    },
    handler((args: {
      id: string;
      version: string;
      note?: string;
      url?: string;
      tag?: string;
      date?: string;
      actor?: string;
    }) => {
      const { id, ...rest } = args;
      const p = projects.reportRelease(id, { ...rest, source: 'agent' });
      return receipt(p, { version: args.version, last_release: p.last_release, release_count: p.release_count });
    }),
  );

  server.registerTool(
    'pm_upsert_goal',
    {
      title: '维护项目目标',
      description: '新增或更新项目目标。传 goal_id 即更新，否则新增。',
      inputSchema: {
        id: z.string(),
        goal_id: z.string().optional(),
        title: z.string().optional().describe('新增时必填'),
        metric: z.string().optional(),
        target: z.number().optional(),
        current: z.number().optional(),
        due: z.string().optional(),
        status: z.enum(['open', 'done', 'dropped']).optional(),
      },
      annotations: WRITE,
    },
    handler((args: { id: string; goal_id?: string; title?: string }) => {
      if (!args.goal_id && !args.title) throw new Error('新增目标必须提供 title');
      const { id, goal_id, ...rest } = args;
      const p = projects.upsertGoal(id, {
        ...(rest as Parameters<typeof projects.upsertGoal>[1]),
        id: goal_id,
        title: (rest.title ?? '') as string,
      });
      const goal = p.goals.find((g) => g.id === goal_id || g.title === rest.title);
      return receipt(p, {
        goal_id: goal?.id ?? null,
        goal_status: goal?.status ?? null,
        goals_count: p.goals.length,
      });
    }),
  );

  server.registerTool(
    'pm_upsert_roadmap_item',
    {
      title: '维护路线图',
      description: '新增或更新未来规划条目。每日计划基于未完成条目推导，请保持它有效。',
      inputSchema: {
        id: z.string(),
        item_id: z.string().optional(),
        title: z.string().optional().describe('新增时必填'),
        due: z.string().optional(),
        status: z.enum(['planned', 'in_progress', 'done', 'dropped']).optional(),
        description: z.string().optional(),
      },
      annotations: WRITE,
    },
    handler((args: { id: string; item_id?: string; title?: string }) => {
      if (!args.item_id && !args.title) throw new Error('新增路线图条目必须提供 title');
      const { id, item_id, ...rest } = args;
      const p = projects.upsertRoadmapItem(id, {
        ...(rest as Parameters<typeof projects.upsertRoadmapItem>[1]),
        id: item_id,
        title: (rest.title ?? '') as string,
      });
      const item = p.roadmap.find((r) => r.id === item_id || r.title === rest.title);
      return receipt(p, {
        item_id: item?.id ?? null,
        item_status: item?.status ?? null,
        roadmap_count: p.roadmap.length,
      });
    }),
  );

  server.registerTool(
    'pm_link_repo',
    {
      title: '关联/解绑仓库',
      description: '关联本地 git 仓库，之后 pm_sync_git 会自动采集其 commit 到时间线。',
      inputSchema: {
        id: z.string(),
        path: z.string().optional().describe('本地仓库绝对路径'),
        url: z.string().optional().describe('远程地址（仅记录）'),
        branch: z.string().optional(),
        unlink: z.boolean().optional().default(false),
      },
      annotations: WRITE,
    },
    handler((args: { id: string; path?: string; url?: string; branch?: string; unlink: boolean }) => {
      const key = args.path ?? args.url;
      if (!key) throw new Error('需要 path 或 url');
      const p = args.unlink
        ? projects.unlinkRepo(args.id, key)
        : projects.linkRepo(args.id, { path: args.path, url: args.url, branch: args.branch });
      return receipt(p, { linked: !args.unlink, repo_count: p.repos.length });
    }),
  );

  // ------------------------------------------------------------------ 每日计划

  server.registerTool(
    'pm_generate_daily_plan',
    {
      title: '生成当日计划',
      description:
        '按「阻塞 > 落后时间轴 > 临近里程碑 > 临近目标 > 滞涨 > 常规推进」打分，产出当日任务清单（含理由）。保留已有的已完成与人工任务。',
      inputSchema: {
        date: z.string().optional().describe('默认今天'),
        max_tasks: z.number().int().positive().optional().describe('默认取配置值'),
        replace: z.boolean().optional().default(false).describe('true 则丢弃已有未完成任务'),
        focus: z.string().optional().describe('今日额外关注点'),
      },
      annotations: WRITE,
    },
    handler((args: Parameters<typeof plans.generate>[0]) => {
      const { plan, candidates } = plans.generate({ ...args, source: 'agent' });
      return {
        date: plan.date,
        status: plan.status,
        summary: plan.summary,
        tasks: plan.tasks,
        candidate_count: candidates,
      };
    }),
  );

  server.registerTool(
    'pm_get_daily_plan',
    {
      title: '读取当日计划',
      description: '读取指定日期（默认今天）的每日计划与任务状态。',
      inputSchema: { date: z.string().optional() },
      annotations: READ_ONLY,
    },
    handler((args: { date?: string }) => {
      const plan = plans.get(args.date);
      return plan ?? { date: args.date ?? store.today(), status: 'none', tasks: [], summary: '当天暂无计划，可调用 pm_generate_daily_plan 生成' };
    }),
  );

  server.registerTool(
    'pm_upsert_daily_task',
    {
      title: '新增/更新当日任务',
      description: '往当天计划里加一条任务，或更新已有任务（task_id 匹配 id 或标题）。',
      inputSchema: {
        date: z.string().optional().describe('默认今天'),
        task_id: z.string().optional(),
        project_id: z.string().optional(),
        title: z.string(),
        status: z.enum(TASK_STATUS).optional(),
        estimate: z.string().optional(),
        rationale: z.string().optional(),
      },
      annotations: WRITE,
    },
    handler((args: {
      date?: string;
      task_id?: string;
      project_id?: string;
      title: string;
      status?: (typeof TASK_STATUS)[number];
      estimate?: string;
      rationale?: string;
    }) => {
      const date = args.date ?? store.today();
      if (args.task_id) {
        return plans.updateTask(date, args.task_id, {
          title: args.title,
          status: args.status,
          estimate: args.estimate,
          rationale: args.rationale,
          project_id: args.project_id,
        });
      }
      return plans.addTask(date, {
        project_id: args.project_id,
        title: args.title,
        status: args.status ?? 'todo',
        estimate: args.estimate,
        rationale: args.rationale,
        source: 'agent',
      });
    }),
  );

  server.registerTool(
    'pm_complete_daily_task',
    {
      title: '完成当日任务',
      description:
        '把任务标记为完成，并自动向所属项目回写一条进展事件（可带 delta/progress），形成闭环。',
      inputSchema: {
        task_id: z.string().describe('任务 id 或标题'),
        date: z.string().optional().describe('默认今天'),
        note: z.string().optional().describe('进展说明'),
        delta: z.number().optional().describe('同时上报进度增量'),
        progress: z.number().min(0).max(100).optional().describe('同时上报绝对进度'),
        actor: z.string().optional(),
      },
      annotations: WRITE,
    },
    handler((args: { task_id: string; date?: string; note?: string; delta?: number; progress?: number; actor?: string }) => {
      const date = args.date ?? store.today();
      const { plan, task } = plans.completeTask(date, args.task_id, {
        note: args.note,
        delta: args.delta,
        progress: args.progress,
        actor: args.actor,
        type: 'progress',
      });
      return {
        completed: task,
        plan_status: plan.status,
        remaining: plan.tasks.filter((t) => t.status !== 'done').length,
      };
    }),
  );

  // ------------------------------------------------------------------ 集成与配置

  server.registerTool(
    'pm_sync_git',
    {
      title: '同步 Git 提交与发布',
      description:
        '扫描已关联仓库：commit 写入项目记录（只影响活跃度；含 [pm:项目id] +10 时才调整进度），' +
        '命名符合版本号规范的 tag 会被识别为一次发布并留档。',
      inputSchema: {
        project_id: z.string().optional().describe('仅同步指定项目，省略则同步全部'),
        since: z.string().optional().describe('ISO 时间，省略则从上次同步点开始'),
        max_commits: z.number().int().positive().optional().default(200),
      },
      annotations: WRITE,
    },
    handler((args: { project_id?: string; since?: string; max_commits: number }) =>
      syncGit(store, projects, {
        projectId: args.project_id,
        since: args.since,
        maxCommits: args.max_commits,
      }),
    ),
  );

  server.registerTool(
    'pm_get_config',
    {
      title: '读取看板配置',
      description: '查看健康度规则、日程生成策略、自定义字段定义与适配器开关。',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    handler(() => ({ paths: store.paths, config: store.config })),
  );

  server.registerTool(
    'pm_update_config',
    {
      title: '更新看板配置',
      description:
        '深度合并配置补丁。可用于调整健康度阈值、每日任务上限、注册自定义字段（customFields）、开关适配器。',
      inputSchema: {
        patch: z.record(z.unknown()).describe('配置补丁对象，如 {"planning":{"maxTasksPerDay":6}}'),
      },
      annotations: WRITE,
    },
    handler((args: { patch: Record<string, unknown> }) => {
      const next = mergeConfig(store.config, args.patch);
      store.saveConfig(next);
      return next;
    }),
  );

  // ------------------------------------------------------------------ 资源

  server.registerResource(
    'today-brief',
    'pm://brief/today',
    {
      title: '今日简报',
      description: '当前风险、滞涨项目与今日计划的可读简报',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: plans.brief() }],
    }),
  );

  server.registerResource(
    'project-summary',
    'pm://summary',
    {
      title: '全局汇总',
      description: '所有项目的状态、健康度与风险汇总（JSON）',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(projects.summary(), null, 2) },
      ],
    }),
  );

  return server;
}
