import fs from 'node:fs';
import { createApp } from '../app.ts';
import { analyzeRisks } from '../core/risk.ts';
import { discoverRepos, syncGit } from '../collectors/git.ts';
import { mergeConfig } from '../store/config.ts';
import type { ProjectFilter, ProjectStatus, SourceKind, UpdateType } from '../core/types.ts';
import { truncate } from '../core/utils.ts';

interface Parsed {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          out.flags[a.slice(2)] = next;
          i += 1;
        } else {
          out.flags[a.slice(2)] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function str(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function num(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = str(flags, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function bool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === 'true';
}

/** 来源标记：默认按人工记录，Agent 用 CLI 兜底时应显式 --source agent */
function sourceOf(flags: Record<string, string | boolean>): SourceKind {
  const s = str(flags, 'source');
  return (s === 'agent' || s === 'git' || s === 'integration' ? s : 'user') as SourceKind;
}

function out(data: unknown): void {
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

const HELP = `项目管理看板 CLI

查询
  pm list [--status active] [--health at_risk] [--query 关键词] [--tags a,b] [--all] [--json]
  pm show <id> [--timeline 30]
  pm summary [--json]
  pm brief [--date 2026-10-12]
  pm reminders [--stalled 10] [--min-level high|medium|low]   # 只会报「计划停滞」
  pm feed [--limit 40] [--types note,release] [<项目id>]       # 跨项目动态流

写入
  pm add --name "名称" [--description "..."] [--status active] [--progress 30]
         [--priority P1] [--tags a,b] [--target 2026-12-31] [--repo <path>] [--body-file <file>]
  pm update <id> [--status] [--progress] [--priority] [--target] [--tags] [--description]
  pm progress <id> "进展说明" [--delta 10] [--progress 40] [--type note|blocker] [--actor me] [--commit sha]
              # Agent 兜底调用时请加 --source agent，否则看板上会记为「人工」
  pm release <id> --version v0.3.2 [--note "包含什么"] [--url ...] [--tag ...] [--date ISO]
  pm goal <id> --title "目标" [--id g1] [--target 10] [--current 2] [--due 2026-11-01] [--status open]
  pm roadmap <id> --title "里程碑" [--id r1] [--due 2026-11-01] [--status planned|in_progress|done]
  pm link <id> --path <repo> [--branch main]
  pm unlink <id> --path <repo>
  pm archive <id>          # 归档
  pm rm <id> [--hard]      # 硬删除

每日计划
  pm plan                  # 读取今天的计划
  pm plan generate [--date] [--max 5] [--replace] [--focus "..."]
  pm plan status proposed|active|closed [--date]
  pm task add --title "任务" [--project id] [--estimate 2h]
  pm task done <taskId> [--date] [--note "..."] [--delta 10]

集成与维护
  pm git sync [--project id] [--since ISO] [--max 200]
  pm git discover [--root <dir>] [--depth 2]
  pm reindex
  pm config [--json]
  pm config set '<json补丁>'

访问鉴权
  pm auth show                             # 查看凭据来源（面板 / 环境变量 / 未启用）
  pm auth set --password <口令> [--user pm]  # 写入面板凭据；口令改错了用它救回来
  pm auth reset                            # 清除面板凭据，回落到环境变量

服务
  pm serve [--port 8930]                       # 统一服务：看板 UI + REST API + MCP(HTTP) 同端口
  pm serve --lan --password <口令> [--user pm]  # 开放局域网访问；MCP 共用同一套凭据
  pm serve --no-mcp                            # 只跑看板，不挂 MCP 端点
  pm mcp stdio                                 # stdio 传输：本地 Agent 直连（推荐）
  pm mcp http                                  # 独立 MCP(HTTP)：只有 MCP 端点，无看板、无认证
  pm ui                                        # pm serve 的旧名字，行为一致
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { _, flags } = parseArgs(argv);
  const [cmd, sub] = _;

  if (!cmd || cmd === 'help' || flags.help) {
    console.log(HELP);
    return;
  }

  if (cmd === 'mcp') {
    if (sub === 'http') await import('../mcp/http.ts');
    else await import('../mcp/stdio.ts');
    return;
  }

  // 凭据存在数据目录里，不需要建整个 app（省掉一次 SQLite 装配）
  if (cmd === 'auth') {
    const { resolvePaths } = await import('../store/paths.ts');
    const { authFilePath, clearAuth, loadAuth, saveAuth, MIN_PASSWORD_LENGTH } = await import(
      '../store/auth.ts'
    );
    const paths = resolvePaths();

    if (sub === 'reset') {
      clearAuth(paths);
      console.log('已清除面板凭据');
      console.log(
        process.env.PM_PASSWORD || process.env.PM_TOKEN
          ? '  运行中的服务几秒内会回落到环境变量里的口令；重启同样生效'
          : '  运行中的服务几秒内会变成「不再校验」——局域网模式下请尽快重新设置',
      );
      return;
    }

    if (sub === 'set') {
      const user = str(flags, 'user') ?? 'pm';
      const password = str(flags, 'password') ?? '';
      if (password.length < MIN_PASSWORD_LENGTH) {
        console.error(`口令至少 ${MIN_PASSWORD_LENGTH} 位：pm auth set --password <口令>`);
        process.exit(1);
      }
      saveAuth(paths, user, password);
      console.log(`已写入面板凭据：用户名 ${user}`);
      console.log(`  文件: ${authFilePath(paths)}`);
      console.log('  运行中的服务几秒内自动生效（也可以直接在看板「设置」里改）');
      return;
    }

    // 默认 show
    const record = loadAuth(paths);
    if (record) {
      console.log(`来源: 面板管理（用户名 ${record.user}）`);
      console.log(`  文件: ${authFilePath(paths)}`);
      console.log(`  更新: ${record.updated_at || '未知'}`);
    } else if (process.env.PM_PASSWORD || process.env.PM_TOKEN) {
      console.log(`来源: 环境变量（用户名 ${process.env.PM_USER ?? 'pm'}）`);
    } else {
      console.log('来源: 未启用 —— 仅应在只绑本机回环时才这样');
    }
    return;
  }

  // serve 是推荐的名字（看板 + API + MCP 一体）；ui 是它的旧名字，行为一致
  if (cmd === 'serve' || cmd === 'ui') {
    const { startApiServer } = await import('../api/server.ts');
    const lan = bool(flags, 'lan');
    startApiServer({
      port: num(flags, 'port'),
      // --lan 等价于绑定所有网卡；也可用 --host 指定具体地址
      host: str(flags, 'host') ?? (lan ? '0.0.0.0' : undefined),
      user: str(flags, 'user'),
      password: str(flags, 'password') ?? null,
      mcp: !bool(flags, 'no-mcp'),
    });
    return;
  }

  const app = createApp();
  const { store, projects, plans } = app;

  switch (cmd) {
    case 'list': {
      const filter: ProjectFilter = {
        status: str(flags, 'status')?.split(',') as ProjectStatus[] | undefined,
        health: str(flags, 'health')?.split(',') as ProjectFilter['health'],
        priority: str(flags, 'priority')?.split(',') as ProjectFilter['priority'],
        tags: str(flags, 'tags')?.split(','),
        query: str(flags, 'query'),
        include_archived: bool(flags, 'all'),
      };
      const rows = projects.cards(filter);
      if (bool(flags, 'json')) {
        out({ count: rows.length, projects: rows });
        break;
      }
      if (!rows.length) {
        console.log('（没有匹配的项目，可用 pm add 创建）');
        break;
      }
      const head = ['ID', '名称', '状态', '进度', '健康', '优先级', '闲置(天)', '截止'];
      const body = rows.map((r) => [
        r.id,
        truncate(r.name, 18),
        r.status,
        `${r.progress}%`,
        r.health,
        r.priority,
        String(r.days_since_activity),
        r.target_date ?? '-',
      ]);
      console.log(table([head, ...body]));
      break;
    }

    case 'show': {
      const id = _[1];
      if (!id) throw new Error('用法: pm show <id>');
      const p = projects.get(id, { timeline_limit: num(flags, 'timeline') ?? 20 });
      out(p);
      break;
    }

    case 'summary': {
      const s = projects.summary();
      if (bool(flags, 'json')) {
        out(s);
        break;
      }
      console.log(
        `项目 ${s.totals.projects} 个（进行中 ${s.totals.active}，归档 ${s.totals.archived}），平均进度 ${s.totals.avg_progress}%`,
      );
      console.log(`状态分布: ${fmtCounts(s.by_status)}`);
      console.log(`健康分布: ${fmtCounts(s.by_health)}`);
      if (s.at_risk.length) {
        console.log('\n风险项目:');
        for (const r of s.at_risk) console.log(`  - [${r.id}] ${r.name}：${r.reason}`);
      }
      if (s.stale.length) {
        console.log('\n滞涨项目:');
        for (const r of s.stale) console.log(`  - [${r.id}] ${r.name}：${r.days_since_activity} 天无进展`);
      }
      if (s.upcoming.length) {
        console.log('\n临近截止:');
        for (const r of s.upcoming)
          console.log(`  - [${r.id}] ${r.name}：剩 ${r.days_left} 天（${r.target_date}），当前 ${r.progress}%`);
      }
      break;
    }

    case 'brief': {
      console.log(plans.brief(str(flags, 'date')));
      break;
    }

    case 'reminders':
    case 'risk': {
      const min = (str(flags, 'min-level') ?? 'low') as 'high' | 'medium' | 'low';
      const stalled = num(flags, 'stalled') ?? store.config.reminders.planStalledAfterDays;
      const rank = { high: 0, medium: 1, low: 2 };
      const reminders = analyzeRisks(projects, stalled).filter((r) => rank[r.level] <= rank[min]);
      if (!reminders.length) {
        console.log(`没有停滞的计划（阈值 ${stalled} 天）。`);
        break;
      }
      for (const r of reminders) {
        console.log(`[${r.level.toUpperCase()}] ${r.project}`);
        console.log(`   现状: ${r.detail}`);
        console.log(`   建议: ${r.suggestion}`);
      }
      break;
    }

    case 'feed': {
      const rows = projects.feed({
        limit: num(flags, 'limit') ?? 40,
        project_id: _[1],
        types: str(flags, 'types')?.split(',') as UpdateType[] | undefined,
      });
      if (!rows.length) {
        console.log('还没有任何记录。');
        break;
      }
      for (const e of rows) {
        const d = new Date(e.ts);
        const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(
          d.getHours(),
        ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const tag = e.version ? `${e.version} ` : '';
        console.log(
          `${stamp}  ${pad(e.project_name, 18)} [${e.type}] ${tag}${e.content}`,
        );
      }
      break;
    }

    case 'release': {
      const id = _[1];
      const version = str(flags, 'version') ?? _[2];
      if (!id || !version) {
        throw new Error('用法: pm release <id> --version v1.0.0 [--note "..."] [--url ...] [--tag ...]');
      }
      const p = projects.reportRelease(id, {
        version,
        note: str(flags, 'note'),
        url: str(flags, 'url'),
        tag: str(flags, 'tag'),
        date: str(flags, 'date'),
        actor: str(flags, 'actor') ?? 'cli',
        source: sourceOf(flags),
      });
      console.log(`已记录发布 ${version}（${p.id} 累计 ${p.release_count} 次发布）`);
      break;
    }

    case 'add': {
      const name = str(flags, 'name');
      if (!name) throw new Error('用法: pm add --name "名称"');
      const bodyFile = str(flags, 'body-file');
      const body = bodyFile ? readText(bodyFile) : undefined;
      const p = projects.create({
        name,
        id: str(flags, 'id'),
        description: str(flags, 'description'),
        status: str(flags, 'status') as ProjectStatus | undefined,
        progress: num(flags, 'progress'),
        priority: str(flags, 'priority') as 'P0' | 'P1' | 'P2' | 'P3' | undefined,
        tags: str(flags, 'tags')?.split(','),
        target_date: str(flags, 'target'),
        body,
        source: 'user',
        actor: str(flags, 'actor'),
      });
      const repo = str(flags, 'repo');
      if (repo) projects.linkRepo(p.id, { path: repo, branch: str(flags, 'branch') });
      console.log(`已创建项目 ${p.id}`);
      out(projects.cards({ query: p.id })[0]);
      break;
    }

    case 'update': {
      const id = _[1];
      if (!id) throw new Error('用法: pm update <id> [--status ...] [--progress N]');
      const target = str(flags, 'target');
      const p = projects.update(id, {
        status: str(flags, 'status') as ProjectStatus | undefined,
        progress: num(flags, 'progress'),
        priority: str(flags, 'priority') as 'P0' | 'P1' | 'P2' | 'P3' | undefined,
        tags: str(flags, 'tags')?.split(','),
        description: str(flags, 'description'),
        target_date: target === 'none' ? null : target,
        source: 'user',
        actor: str(flags, 'actor'),
      });
      console.log(`已更新 ${p.id}：${p.progress}% / ${p.status} / ${p.health}`);
      break;
    }

    case 'progress': {
      const id = _[1];
      const content = _[2];
      if (!id || !content) throw new Error('用法: pm progress <id> "进展说明" [--delta 10]');
      const commit = str(flags, 'commit');
      const p = projects.reportProgress(id, {
        content,
        delta: num(flags, 'delta'),
        progress: num(flags, 'progress'),
        type: str(flags, 'type') as UpdateType | undefined,
        actor: str(flags, 'actor') ?? 'cli',
        refs: commit ? { commit } : undefined,
        source: sourceOf(flags),
      });
      console.log(`已记录进展，${p.id} 当前进度 ${p.progress}%`);
      break;
    }

    case 'goal': {
      const id = _[1];
      const title = str(flags, 'title');
      if (!id) throw new Error('用法: pm goal <id> [--title ...] [--id g1] ...');
      const goalId = str(flags, 'id');
      if (!title && !goalId) throw new Error('需要 --title 或 --id');
      const p = projects.upsertGoal(id, {
        id: goalId,
        title: title ?? '',
        metric: str(flags, 'metric'),
        target: num(flags, 'target'),
        current: num(flags, 'current'),
        due: str(flags, 'due'),
        status: str(flags, 'status') as 'open' | 'done' | 'dropped' | undefined,
      });
      console.log(`目标已更新，${p.id} 现有 ${p.goals.length} 个目标`);
      break;
    }

    case 'roadmap': {
      const id = _[1];
      if (!id) throw new Error('用法: pm roadmap <id> --title "里程碑" [--due 2026-11-01]');
      const itemId = str(flags, 'id');
      const title = str(flags, 'title');
      if (!title && !itemId) throw new Error('需要 --title 或 --id');
      const p = projects.upsertRoadmapItem(id, {
        id: itemId,
        title: title ?? '',
        due: str(flags, 'due'),
        status: str(flags, 'status') as 'planned' | 'in_progress' | 'done' | 'dropped' | undefined,
        description: str(flags, 'description'),
      });
      console.log(`路线图已更新，${p.id} 现有 ${p.roadmap.length} 条`);
      break;
    }

    case 'link':
    case 'unlink': {
      const id = _[1];
      const repoPath = str(flags, 'path') ?? str(flags, 'url');
      if (!id || !repoPath) throw new Error(`用法: pm ${cmd} <id> --path <repo>`);
      const p =
        cmd === 'link'
          ? projects.linkRepo(id, { path: str(flags, 'path'), url: str(flags, 'url'), branch: str(flags, 'branch') })
          : projects.unlinkRepo(id, repoPath);
      console.log(`${cmd === 'link' ? '已关联' : '已解绑'}：${p.repos.map((r) => r.path ?? r.url).join(', ') || '（无）'}`);
      break;
    }

    case 'archive': {
      const id = _[1];
      if (!id) throw new Error('用法: pm archive <id>');
      out(projects.remove(id, false));
      break;
    }

    case 'rm': {
      const id = _[1];
      if (!id) throw new Error('用法: pm rm <id> [--hard]');
      out(projects.remove(id, bool(flags, 'hard')));
      break;
    }

    case 'plan': {
      if (sub === 'status') {
        const status = _[2] ?? str(flags, 'status');
        if (!status) throw new Error('用法: pm plan status <proposed|active|closed> [--date]');
        const plan = plans.setStatus(
          str(flags, 'date') ?? store.today(),
          status as 'proposed' | 'active' | 'closed',
        );
        console.log(`计划 ${plan.date} 状态已改为 ${plan.status}`);
        break;
      }
      if (sub === 'generate') {
        const { plan, candidates } = plans.generate({
          date: str(flags, 'date'),
          maxTasks: num(flags, 'max'),
          replace: bool(flags, 'replace'),
          focus: str(flags, 'focus'),
          source: 'agent',
        });
        console.log(`已生成 ${plan.date} 计划（候选 ${candidates} 项，采纳 ${plan.tasks.length} 项）`);
        console.log(plan.summary);
        printTasks(plan.tasks);
        break;
      }
      const plan = plans.get(str(flags, 'date'));
      if (!plan) {
        console.log('当天暂无计划，先执行：pm plan generate');
        break;
      }
      console.log(`# ${plan.date}（${plan.status}）\n${plan.summary}`);
      printTasks(plan.tasks);
      break;
    }

    case 'task': {
      const date = str(flags, 'date');
      if (sub === 'add') {
        const title = str(flags, 'title');
        if (!title) throw new Error('用法: pm task add --title "任务"');
        const plan = plans.addTask(date ?? store.today(), {
          title,
          project_id: str(flags, 'project'),
          status: (str(flags, 'status') as 'todo' | 'doing' | 'done') ?? 'todo',
          estimate: str(flags, 'estimate'),
          source: 'user',
        });
        console.log(`已加入 ${plan.date} 计划（共 ${plan.tasks.length} 项）`);
        break;
      }
      if (sub === 'done') {
        const taskId = _[2];
        if (!taskId) throw new Error('用法: pm task done <taskId> [--delta 10]');
        const { plan, task } = plans.completeTask(date ?? store.today(), taskId, {
          note: str(flags, 'note'),
          delta: num(flags, 'delta'),
          progress: num(flags, 'progress'),
          actor: str(flags, 'actor') ?? 'cli',
        });
        console.log(`已完成：${task.title}；剩余 ${plan.tasks.filter((t) => t.status !== 'done').length} 项`);
        break;
      }
      throw new Error('用法: pm task add|done ...');
    }

    case 'git': {
      if (sub === 'sync') {
        const r = syncGit(store, projects, {
          projectId: str(flags, 'project'),
          since: str(flags, 'since'),
          maxCommits: num(flags, 'max') ?? 200,
        });
        out(r);
        break;
      }
      if (sub === 'discover') {
        const root = str(flags, 'root') ?? process.cwd();
        const repos = discoverRepos(root, num(flags, 'depth') ?? 2);
        console.log(repos.length ? repos.join('\n') : '未发现 git 仓库');
        break;
      }
      throw new Error('用法: pm git sync|discover');
    }

    case 'reindex': {
      const n = store.rebuildIndex();
      console.log(`索引已重建：${n} 个项目`);
      break;
    }

    case 'config': {
      if (sub === 'set') {
        const patchRaw = _[2];
        if (!patchRaw) throw new Error("用法: pm config set '{\"planning\":{\"maxTasksPerDay\":6}}'");
        const patch = JSON.parse(patchRaw) as Record<string, unknown>;
        const next = mergeConfig(store.config, patch);
        store.saveConfig(next);
        out(next);
        break;
      }
      out({ paths: store.paths, config: store.config });
      break;
    }

    case 'seed': {
      seedDemo(app);
      break;
    }

    default:
      console.log(HELP);
  }

  store.close();
}

function printTasks(tasks: Array<{ status: string; title: string; project_id?: string; rationale?: string }>): void {
  for (const t of tasks) {
    const box = t.status === 'done' ? 'x' : t.status === 'doing' ? '~' : ' ';
    console.log(`  [${box}] ${t.title}${t.project_id ? ` (@${t.project_id})` : ''}`);
    if (t.rationale) console.log(`        ↳ ${t.rationale}`);
  }
}

function fmtCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([k, v]) => `${k}:${v}`).join('  ') : '（空）';
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => displayWidth(r[i] ?? ''))));
  return rows
    .map((r, idx) => {
      const line = r.map((c, i) => pad(c ?? '', widths[i]!)).join('  ');
      return idx === 1 ? `${line}\n${widths.map((w) => '-'.repeat(w)).join('  ')}` : line;
    })
    .join('\n');
}

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return w;
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

function readText(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function seedDemo(app: ReturnType<typeof createApp>): void {
  const { store, projects, plans } = app;
  const existing = projects.list({ include_archived: true });
  if (existing.length) {
    console.log(`数据目录已有 ${existing.length} 个项目，跳过示例数据（如需可以手动删除后再试）。`);
    return;
  }
  const today = store.today();

  const a = projects.create({
    id: 'project-manager',
    name: 'Project Manager 看板',
    description: '本地优先的项目管理看板，Markdown 事实源 + MCP 服务',
    status: 'active',
    progress: 35,
    priority: 'P1',
    tags: ['tooling', 'mcp'],
    target_date: addDaysStr(today, 45),
    source: 'user',
    goals: [
      { id: 'g1', title: 'MCP 服务可用', metric: '工具数', target: 12, current: 12, due: addDaysStr(today, 10) },
      { id: 'g2', title: '看板 UI 上线', metric: '视图数', target: 4, current: 0, due: addDaysStr(today, 40) },
    ],
    roadmap: [
      { id: 'r1', title: 'MCP 工具与 Skill 打通', due: addDaysStr(today, 3), status: 'in_progress' },
      { id: 'r2', title: 'Web 看板四视图', due: addDaysStr(today, 25), status: 'planned' },
      { id: 'r3', title: '适配器生态（Jira/CI 接入）', due: addDaysStr(today, 58), status: 'planned' },
    ],
  });
  projects.linkRepo(a.id, { path: store.paths.root, branch: 'main' });
  projects.reportProgress(a.id, {
    content: 'REST API 与看板四视图完成，进入联调',
    delta: 20,
    source: 'agent',
    actor: 'codebuddy',
  });

  const b = projects.create({
    id: 'pipeline-refactor',
    name: '数据管线重构',
    description: '把批处理管线切换到流式架构，降低端到端延迟',
    status: 'blocked',
    progress: 60,
    priority: 'P0',
    tags: ['infra'],
    target_date: addDaysStr(today, 8),
    source: 'user',
    roadmap: [
      { id: 'r1', title: '双写灰度', due: addDaysStr(today, -2), status: 'in_progress' },
      { id: 'r2', title: '下线旧链路', due: addDaysStr(today, 20), status: 'planned' },
    ],
  });
  projects.reportProgress(b.id, {
    content: '等待 DBA 审批建表，阻塞中',
    type: 'blocker',
    source: 'user',
    actor: 'seed',
  });

  const c = projects.create({
    id: 'docs-site',
    name: '文档站改版',
    description: '把文档站迁移到新的主题并补齐搜索',
    status: 'active',
    progress: 15,
    priority: 'P2',
    tags: ['docs'],
    target_date: addDaysStr(today, 60),
    source: 'user',
    goals: [
      { id: 'g1', title: '搜索命中率', metric: '%', target: 90, current: 62, due: addDaysStr(today, 35) },
    ],
    roadmap: [
      { id: 'r1', title: '主题迁移', due: addDaysStr(today, 7), status: 'in_progress' },
      { id: 'r2', title: '全量搜索补齐', due: addDaysStr(today, 24), status: 'planned' },
      { id: 'r3', title: '旧站下线', due: addDaysStr(today, 52), status: 'planned' },
    ],
  });
  projects.reportProgress(c.id, {
    content: '主题迁移完成 1/3 页面，样式已对齐设计稿',
    delta: 5,
    source: 'user',
    actor: 'seed',
  });

  const { plan } = plans.generate({ source: 'agent', actor: 'seed' });
  console.log(`示例数据已写入：3 个项目 + ${plan.date} 计划（${plan.tasks.length} 项任务）`);
  console.log('可以试试： pm list   /   pm summary   /   pm brief   /   pm risk');
}

function addDaysStr(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

main().catch((err: unknown) => {
  console.error(`错误：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
