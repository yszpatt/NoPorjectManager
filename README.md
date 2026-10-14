# 项目管理看板（NoProjectManager）

本地优先的项目管理看板。数据以 **Markdown 为事实源**、**SQLite 为查询索引**，通过 **MCP 服务**向各类 Agent 与 harness 暴露读写能力，并配有 **Skill** 与 **Hooks** 形成「拉取计划 → 执行 → 自动汇报」的闭环。

**它按「项目档案」组织，而不是排期表**：关注的是**你的思考、下一步打算做什么、发布了哪些版本**。进度百分比与截止日期仍然记录，但退到详情页当辅助信息——对独立开发的自用小工具来说，维护排期的成本远高于它带来的行动价值。详见[提醒](#提醒只有一种)与[为降低维护成本做的取舍](#为降低维护成本做的取舍)。

```
┌─────────────────────────────────────────────┐
│ 消费者                                       │
│ 看板 UI │ MCP Client（Agent） │ CLI │ Hooks  │
└────┬────────────┬───────────────┬──────┬─────┘
     │ HTTP /api  │ stdio / HTTP  │      │
┌────▼────────────▼───────────────▼──────▼─────┐
│ 接入层  API Server · MCP Server · CLI/Hooks   │
├──────────────────────────────────────────────┤
│ 领域层  ProjectService · PlanService          │
│         RiskEngine · 事件总线 · 适配器注册表   │
└──────────────────┬───────────────────────────┘
                   │
┌──────────────────▼───────────────────────────┐
│ 存储层                                        │
│ 事实源：Markdown + YAML / JSONL（可 diff）     │
│ 索引：  SQLite（可重建）                       │
└──────────────────┬───────────────────────────┘
                   │
   GitCollector（commit / tag → 事件流）
```

## 三条数据通道

| 通道 | 入口 | 写入内容 |
|---|---|---|
| Agent | MCP 工具 `pm_report_progress` / `pm_report_release` / `pm_update_project` | 思考记录、发布、计划、进度 |
| 人工 | 看板界面、CLI、或直接编辑 `.projectmanager/` 下的 Markdown | 同上 |
| Git | `pm_sync_git` 扫描 commit 与 tag | commit → 活跃度（message 含 `[pm:id] +10` 时才调整进度）；版本 tag → 发布记录 |

三者写入同一份事实源，来源在事件流中留痕（`source: agent/user/git/integration`）。⚠️ 用 CLI 或 REST 兜底时 Agent 必须显式声明 `--source agent` / `{"source":"agent"}`，否则会被记为「人工」，破坏可追溯性。

### 提交与汇报的合并

同一件事常常既留下提交、又被 Agent 汇报一次。两条都是事实，分开看就是重复——**一件事只该占一行**。

事实源仍是两条独立的 append-only 事件（提交是事实、汇报是叙述），**合并只发生在读取时**，因此不丢原始数据，重建索引也能得到同样的结果。

| 关联方式 | 规则 |
|---|---|
| **显式**（推荐） | 汇报里写 `refs.commit`（多个用 `refs.commits`，逗号或空格分隔）。按 sha 前缀匹配，**不受时间限制** |
| 自动 | 同项目内、`git.autoLinkWindowMinutes`（默认 120 分钟）内**一对一**的提交与汇报。有多对多可能时一律不动——错并比不并更难发现 |

合并后看板只显示汇报那条，提交以短 sha 徽章挂在旁边（悬停可核对原始标题）。同理，`[pm:id] +N` 提交自动产生的「进度 x% → y%」审计事件会并回提交那一条，不再单独占一行。

不参与自动配对的：系统生成的审计事件（`状态 a → b`、`进度 x% → y%`、`创建项目`）与发布记录——它们没有叙述可承载，不该成为合并宿主。自动配对可用 `git.autoLinkReports = false` 关闭，显式 `refs.commit` 始终有效。

> 提交本身怎么写、什么时候该汇报、什么时候不该汇报，见 Skill 的 `.codebuddy/skills/project-manager/references/git.md`。

## 快速开始

```bash
npm install
npm --prefix web install        # 前端依赖（仅看板 UI 需要）

# 写入示例数据（3 个项目 + 当日计划），便于立即看到效果
npm run seed

# 打开看板
npm run ui:build                # 构建前端（首次或改过前端代码后）
npm run ui                      # http://localhost:8930
```

只想用 CLI / MCP 的话，只需 `npm install` + `npm run seed`。

### 前端开发模式

```bash
npm run ui:dev    # Vite dev server: http://localhost:8933，/api 自动代理到 8930
```

### 常用 CLI

```bash
node bin/pm.mjs list
node bin/pm.mjs summary
node bin/pm.mjs brief
node bin/pm.mjs feed --limit 40                         # 跨项目动态流
node bin/pm.mjs reminders --min-level medium            # 只会报「计划停滞」
node bin/pm.mjs add --name "新项目" --id new-project --status active
node bin/pm.mjs roadmap new-project --title "支持批量导入"  # 下一步计划，日期可省
node bin/pm.mjs progress new-project "决定用队列而不是轮询" --type note
node bin/pm.mjs progress new-project "说明" --delta 5 --source agent   # Agent 兜底调用时声明来源
node bin/pm.mjs release new-project --version v0.3.2 --note "支持批量导入"
node bin/pm.mjs plan generate --max 5
node bin/pm.mjs task done <taskId> --delta 5
node bin/pm.mjs git sync          # 采集 commit 与版本 tag
node bin/pm.mjs reindex           # 手工编辑 Markdown 后重建索引
node bin/pm.mjs help
```

### 启动 MCP 服务

```bash
npm run mcp:stdio      # stdio：本地 Agent / harness 直连
npm run mcp:http       # HTTP(Streamable)：http://localhost:8931/mcp
```

注册到客户端时：stdio 用 `command: node` + `args: ["<项目路径>/bin/pm.mjs","mcp","stdio"]`；HTTP 用 `url: http://localhost:8931/mcp`。详见 `.codebuddy/skills/project-manager/references/registration.md`。

## 目录结构

```
.projectmanager/           # 数据根目录（建议纳入 git）
├── projects/<id>.md       # 项目：YAML frontmatter + Markdown 正文
├── events/<id>.jsonl      # 事件流：追加型，一行一个 JSON
├── plans/<date>.md        # 每日计划
├── config.json            # 阈值、日程策略、自定义字段、适配器开关
└── index.sqlite           # 派生索引（已 gitignore，可重建）

src/
├── core/                  # 领域层：类型、健康度、风险、服务、事件总线
├── store/                 # 存储层：Markdown 解析、SQLite 索引、存储门面
├── mcp/                   # MCP 服务（server 定义 + stdio/http 两种传输）
├── api/                   # REST API + 静态资源托管（供看板 UI）
├── collectors/            # Git 采集器，预留 GitHub/Jira/CI
├── cli/                   # CLI 入口（人工操作与 hooks 共用）
└── app.ts                 # 组合根

web/                       # 看板前端（React + Vite + Tailwind v4，图表为自绘 SVG）
├── src/views/             # Board / Feed / Today / Table 四视图
└── src/components/        # 抽屉、进度环、迷你趋势、Markdown 渲染等
bin/pm.mjs                 # pm 可执行入口
scripts/                   # 冒烟测试、容器健康检查
Dockerfile                 # 多阶段构建（前端在镜像内构建）
docker-compose.yml         # 数据卷 / 端口 / 令牌 / 时区
docker-entrypoint.sh       # 无 PM_TOKEN 时自动生成并持久化
.codebuddy/
├── skills/project-manager/   # Agent Skill（SKILL.md + references）
├── hooks/                    # SessionStart / SessionEnd 脚本
└── settings.json             # hooks 注册（需在 /hooks 面板确认生效）
```

## 数据模型

项目事实源示例（`.projectmanager/projects/pipeline-refactor.md`）：

```markdown
---
id: pipeline-refactor
name: 数据管线重构
description: 把批处理管线切换到流式架构
status: blocked
progress: 60
priority: P0
tags:
  - infra
repos:
  - path: c:/workspace/pipeline
    branch: main
target_date: 2026-10-20
created_at: 2026-10-12T13:12:36.635Z
updated_at: 2026-10-12T13:12:36.800Z
goals:
  - id: g1
    title: P99 延迟达标
    metric: ms
    target: 200
    current: 480
    due: 2026-10-18
roadmap:
  - id: r1
    title: 双写灰度
    due: 2026-10-10
    status: in_progress
---

## 介绍

（正文，可自由编辑）
```

事件流示例（`.projectmanager/events/videorag.jsonl`）：

```json
{"id":"git-f6488b91eb55","project_id":"videorag","ts":"2026-10-12T13:17:49.000Z","source":"git","type":"progress","content":"feat: 导入本地视频 [pm:videorag] +10","delta":10,"actor":"smoke","refs":{"commit":"f6488b91eb55"}}
{"id":"release-v0.1","project_id":"videorag","ts":"2026-09-17T07:52:09.000Z","source":"git","type":"release","version":"v0.1","content":"feat(packaging): Windows 桌面包与品牌标识","refs":{"tag":"v0.1","commit":"290816d4c7a6"}}
```

> 时间戳统一以 UTC 存储与比较。git 的 `%aI` 带本地偏移，采集时会归一化成 UTC——混用两种写法会让排序与按天分组错位（例如"早上做的事"被算成前一天）。

### 发布记录
独立开发里最值得留档的事件，同时支持两种产生方式：

| 方式 | 触发 |
|---|---|
| 手动 | 看板抽屉「记录发布」、`pm_report_release`、`pm release <id> --version v0.3.2` |
| 自动 | `pm_sync_git` 扫描仓库 tag，命名匹配 `git.releaseTagPattern`（默认 `^v?\d+(\.\d+)*$`）的 tag 视为一次发布，事件 id 为 `release-<tag>` 保证幂等 |

发布以事件形式落在同一条事件流里，`last_release`（版本 + 时间 + 说明 + tag/commit 引用）与 `release_count` 由事件流派生，无需额外字段。

### 健康度（派生，不落盘）

| 值 | 判定 |
|---|---|
| `blocked` | 状态为 blocked |
| `stale` | 超过 `staleAfterDays`（默认 14）天无任何事件；或状态为 paused |
| `at_risk` | 进度落后于「时间轴预期进度」超过 `atRiskProgressGap`（默认 15）个百分点 |
| `on_track` / `unknown` / `done` | 其它 |

阈值通过 `pm_update_config` 或直接编辑 `config.json` 调整。

**进度来源**由 `progress.mode` 决定（`config.json` 或抽屉右上角开关）：

| 值 | 行为 |
|---|---|
| `declared`（默认） | 使用人工/Agent 显式声明的进度，语义最准但需要维护 |
| `auto` | 进度 = 路线图里程碑完成度（已完成 1 / 进行中 0.5 / 已放弃不计入）。无里程碑时回退到声明值。此时 `pm_report_progress` 的 `delta`/`progress` 只记录事件、不改变展示进度 |

> 注意：`auto` 模式下 Markdown 里保留的仍是你上次声明的 `progress`，展示值由里程碑实时推导——这样切回 `declared` 不会丢失人工判断。

### 提醒（只有一种）

`pm_check_reminders` 与看板上的提醒只回答一个问题：**有明确想做的事，是不是很久没动了？**

| 类型 | 触发条件 |
|---|---|
| `plan_stalled` | 存在未完成的路线图项，但距上次记录超过 `reminders.planStalledAfterDays`（默认 10）天。超过 30 天记为 `high` |
| `no_plan` | 活跃项目既没有未完成计划，也很久没记录 |

**刻意不做**：进度落后、截止临近、里程碑滑期这三类提醒。它们的前提是先维护好排期，对"写自用小工具"的场景既不准确也不催生任何行动——只会制造焦虑。阻塞是一个显式状态，用状态徽章表达即可，不产生提醒。

## MCP 工具（22 个）

| 分组 | 工具 |
|---|---|
| 查询 | `pm_list_projects` `pm_get_project` `pm_summary` `pm_timeline` `pm_brief` `pm_get_feed` `pm_check_reminders` |
| 项目 | `pm_create_project` `pm_update_project` `pm_delete_project` `pm_link_repo` |
| 进展与规划 | `pm_report_progress` `pm_report_release` `pm_upsert_goal` `pm_upsert_roadmap_item` |
| 每日计划 | `pm_generate_daily_plan` `pm_get_daily_plan` `pm_upsert_daily_task` `pm_complete_daily_task` |
| 集成与配置 | `pm_sync_git` `pm_get_config` `pm_update_config` |

资源：`pm://brief/today`、`pm://summary`。完整参数见 `.codebuddy/skills/project-manager/references/tools.md`。

### 每日计划是怎么生成的

`pm_generate_daily_plan` 的推导依据**只有后续计划**——不看进度、不看截止、不看里程碑滑期。
每个非归档项目恰好产出一条候选，按以下顺序命中第一条：

| 场景 | 任务 | 分数 |
|---|---|---|
| 有计划，但超过 `planStalledAfterDays` 天没记录 | 推进或重新思考「X」（停滞 N 天） | 90+ |
| 有标记为「进行中」的计划 | 推进「X」 | 60+ |
| 有计划但都停在「计划中」 | 开始「X」 | 40+ |
| 完全没有未完成计划 | 为「X」写下下一步打算做什么 | 30+ |

再加优先级加权（P0 +15 … P3 -6）与 momentum 微调，取前 `maxTasksPerDay` 条，每条附 `rationale`（为什么今天做它）。

最后一条是有意设计的**元任务**：没有计划就推导不出任何具体动作，所以先提醒你把下一步想清楚。默认**保留**已完成与人工添加的任务，只补充新推导出的，不会覆盖你的编辑。

## Skill 与 Hooks

- **Skill**：`.codebuddy/skills/project-manager/`，教 Agent 何时以及如何读写看板。SKILL.md 保持精简，细节放在 `references/`（conventions / tools / workflows / registration），按需加载。
- **Hooks**（`.codebuddy/settings.json`）：
  - `SessionStart` → 打印今日简报进上下文
  - `SessionEnd` → 自动 `pm git sync`，把提交转成时间线事件

> ⚠️ CodeBuddy 的 `/hooks` 面板是权威入口：直接编辑 `settings.json` 后需在面板中确认/启用。所有 hook 脚本永远 `exit 0`，不会阻断会话。

## 扩展点

| 扩展 | 位置 | 做法 |
|---|---|---|
| 新数据来源 | `src/collectors/` | 实现采集函数，用 `store.appendEvent` 写事件，在 `config.json` 的 `adapters.sources` 登记 |
| 新视图 | P4 的 `web/` | 只消费 `pm_list_projects` / `pm_summary` 的 JSON 输出，无需改动核心 |
| 新导出 | `config.json` 的 `adapters.exporters` | 订阅 `src/core/events.ts` 的事件总线 |
| 自定义字段 | `config.json` 的 `customFields` | 声明 schema，写入项目 `custom` 对象 |
| 外部系统订阅 | `onEvent()` | 所有写入都会广播 `project.*` / `update.appended` / `plan.written` 事件 |

## 看板界面

`npm run ui` 后在浏览器打开 `http://localhost:8930`。四种视图共享同一份数据，任意改动都会实时落盘到 Markdown 事实源。

| 视图 | 内容 |
|---|---|
| **看板** | 按状态分列。卡片固定承载 **5 条信息**，全部围绕「项目档案」：① 名称 + 状态徽章（含优先级色带）② 提醒——只在计划停滞 / 没有计划时出现 ③ **最近一次发布**（版本 + 说明 + 距今多久，未发布则显示「尚未发布」）④ **后续计划**——最近一项未完成项（**不要求有日期**，进行中优先）+ 其余条数 ⑤ **最近一条记录**（内容摘要 + 距今多久）。**卡片可直接拖拽换列**，落盘即更新状态并写入记录。 |
| **动态流** | 跨项目、按时间倒序的原始记录流，回答「最近都在忙什么」。可按类型（全部 / 发布 / 思考 / 计划）与项目筛选，按本地日期分组。侧栏是**计划提醒**与**最近无动静**的项目。 |
| **今日** | 当日计划清单，勾选即完成并自动回写项目进展；「完成并记 Δ」可同时上报进度增量。侧栏是计划提醒。计划状态支持 待确认 → 已确认 → 已结束。 |
| **表格** | 5 列可排序列表（项目 / 状态 / 最近发布 / 后续计划 / 距上次记录），默认按「距上次记录」排序，优先级用项目名前的一条色带表达。 |

**项目详情抽屉**（点击任意卡片/行）首屏只有四件事：进度与截止（**只在详情页出现**，列表与卡片都不展示）、**发布记录**（版本徽章 + 说明 + tag / 发布页链接，附「记录发布」表单）、**未来规划**（点击状态徽章循环切换，新增表单默认收起）、**最近记录**（默认只显示 6 条，可展开全部）。目标 / 关联仓库 / 介绍收在折叠区。所有编辑直接回写 Markdown。

顶栏只有一行：视图切换、三个统计、搜索，其余低频操作收进 `⋯` 菜单。**统计即筛选**——点「在做」只看进行中的项目，点「计划停滞 N」直接跳到动态流看提醒列表。视觉上使用语义化设计令牌，深浅色通过覆盖 CSS 变量整体换肤。

### 局域网访问

默认**只监听本机回环**（`127.0.0.1`），局域网内的其他设备访问不到。需要从手机、平板或另一台电脑打开时：

```bash
node bin/pm.mjs ui --lan                          # 绑定所有网卡，启动时会打印可用的局域网地址
node bin/pm.mjs ui --lan --token <随机字符串>      # 推荐：同时开启访问令牌
```

也可以用环境变量：`PM_HOST`（默认 `127.0.0.1`）、`PM_UI_PORT`（默认 `8930`）、`PM_TOKEN`。

启动后终端会直接给出可复制粘贴的地址：

```
本机:   http://localhost:8930/?token=yqiw1u6dokh58sfx
局域网: http://192.168.9.198:8930/?token=yqiw1u6dokh58sfx
```

前端会从 URL 读取 `token` 并立即从地址栏抹掉，存进 `localStorage`，后续请求自动携带；令牌不对时会弹出输入框。若省略 `--token`，同一网络内的任何人都可读写、归档甚至删除看板数据——服务启动时会就此给出警告。

**注意事项**

- **Windows 防火墙**：首次被外部设备访问时系统会弹窗询问，需要放行；若当时点了拒绝，要手动在「高级安全 Windows 防火墙 → 入站规则」中为 node 放行该端口
- 启动日志里可能同时列出虚拟网卡地址（WSL / Hyper-V / VPN 的 `172.x.x.x` 等），那些地址外部设备通常访问不到，用 `192.168.*` 那类真实局域网地址
- 服务本身没有账号体系，只有一个共享令牌。**不要暴露到公网**，也不要在不可信的公共 Wi-Fi 上开启 `--lan`

### 为降低维护成本做的取舍

看板最大的风险不是功能不够，而是**没人愿意持续填**。因此：

- **默认只显示需要你决策的信息**：卡片固定 5 条（超出的一律不上卡片）、表格 5 列；进度与截止移出所有列表，只在详情页展示
- **登记一个项目只要三件事**：名称、在做什么、什么时候要。id / 状态 / 优先级 / 标签 / 里程碑 / 仓库 / 正文都在「更多选项」里
- **进度可以完全不手工维护**：把 `progress.mode` 设为 `auto` 后，进度 = 路线图里程碑完成度（已完成记 1、进行中记 0.5、已放弃不计入），你只需切换里程碑状态。开关在抽屉右上角（全局设置，默认关闭）
- **新增表单默认收起**：抽屉里的「+ 添加里程碑 / 目标 / 关联仓库」都是先点按钮再展开
- **进展记录默认只显示最近 6 条**，需要时再展开全部
- **阻塞列里不再重复「处于阻塞」**：列标题已经说明了状态，卡片上不重复零信息量的话

## Docker 部署

```bash
docker compose up -d --build
docker compose logs -f board      # 访问令牌会打印在这里
```

然后打开 `http://<主机>:8930/?token=<日志里的令牌>`。数据落在具名卷 `pm-data`，`docker compose down` 不会丢。

### 访问令牌是强制的

容器里**必须**绑定 `0.0.0.0`，否则端口映射进不来——也就是说容器版默认就是「对外暴露」。而看板只有一个共享令牌，缺失时同网络内任何人都能读写、归档甚至删除数据。因此入口脚本在没给 `PM_TOKEN` 时会**自动生成一个**，打印到日志，并持久化到数据卷的 `.token`（重启复用，不会让浏览器里存的令牌失效）。

```bash
docker logs no-project-manager | grep 访问令牌
```

想固定成自己的令牌，在项目根目录建 `.env`（已被 `.gitignore` 忽略）：

```
PM_TOKEN=换成一段随机字符串
```

确实不需要令牌时设 `PM_ALLOW_ANONYMOUS=1`，并建议同时把端口收回回环：

```yaml
ports:
  - "127.0.0.1:8930:8930"
```

### 数据与仓库

| 挂载 | 用途 |
|---|---|
| `pm-data:/data` | 看板全部数据（Markdown 事实源 + SQLite 索引）。**唯一需要长期保留的东西** |
| `<你的代码目录>:/repos:ro` | 可选，想让容器内也能同步 Git 提交记录时才需要 |

用绑定挂载代替具名卷时注意权限——容器以 uid 1000（`node`）运行：

```bash
mkdir -p ./pm-data && sudo chown -R 1000:1000 ./pm-data
docker run -d -p 8930:8930 -v ./pm-data:/data no-project-manager:local
```

Git 同步还要多一步：容器内的仓库路径与宿主机不同，挂到 `/repos/xxx` 后要把项目仓库地址改成**容器内**路径。

```bash
docker exec no-project-manager node bin/pm.mjs link videorag --path /repos/videorag
```

### 时区

容器默认 UTC，而「今天是哪天」直接决定每日计划与动态流的日期分组。compose 里已设 `TZ=Asia/Shanghai`（镜像装了 `tzdata`），换时区改这个变量即可。

### 也支持只跑 MCP 服务

```bash
docker run -d -p 127.0.0.1:8931:8931 -v pm-data:/data no-project-manager:local \
  node bin/pm.mjs mcp http
```

> ⚠️ MCP(HTTP) 服务**没有任何鉴权**。端口一旦对外，等于公开看板数据的读写权限——请只绑回环，或放进受控网络。

要在**宿主机**上以 stdio 方式接给本机 Agent，直接跑 `node bin/pm.mjs mcp stdio` 比绕 Docker 简单。

### 镜像构成

多阶段构建：前端在镜像内构建，运行阶段只装 `--omit=dev` 的依赖；以非 root（`node`，uid 1000）运行；内建 `git` 与 `tzdata`；自带 `HEALTHCHECK`（探测 `/api/health`，令牌从环境变量或数据卷的 `.token` 读取）。构建时会先校验基础镜像是否带内建 `node:sqlite`——缺了就在构建阶段失败，而不是等到运行。

## 验证

```bash
npm run typecheck      # 后端类型检查
npm run ui:typecheck   # 前端类型检查
npm run test:merge     # 记录合并单测：显式关联 / 一对一配对 / 多候选放弃 / 增量转移
npm run smoke          # MCP stdio 冒烟：工具/资源/CRUD/计划/风险 全链路
npm run smoke:http     # MCP HTTP 冒烟：健康检查 + initialize + 工具调用
npm run smoke:api      # 看板 REST API 冒烟：静态页 + 项目 CRUD + 计划闭环
```

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 数据层（Markdown 事实源 + SQLite 索引 + 配置） | ✅ 已完成 |
| P1 | MCP 服务（22 个工具 + stdio/HTTP 双传输） | ✅ 已完成 |
| P2 | Skill + Hooks（会话自动带出计划、收尾自动采集） | ✅ 已完成 |
| P3 | Git 采集器增强（定时任务、PR/Issue 关联） | 🟡 基础能力已完成 |
| P4 | Web 看板 UI（看板 / 动态流 / 今日 / 表格 四视图 + 详情抽屉） | ✅ 已完成 |
| P5 | 日程智能（已改为围绕后续计划推导；LLM 参与取舍、周报生成待做） | 🟡 规则版已完成 |
| P6 | 适配器生态（Jira / Linear / GitHub / CI 接入） | ⬜ 未开始 |

## 环境要求

- Node.js ≥ 22.5（使用内建 `node:sqlite`，无原生编译依赖；本仓库在 Node 24 上验证）
- Git（用于 commit 采集，可选）

所有入口通过 `bin/pm.mjs` 启动，它会带上 `--disable-warning=ExperimentalWarning` 屏蔽 SQLite 实验特性告警，保证 MCP stdio 的 stderr 干净。

不想装 Node 也可以用 [Docker 部署](#docker-部署)，镜像里已经包含与上面同版本的运行时。

## 许可

[MIT](LICENSE)。`.projectmanager/` 目录（看板的运行时数据）默认不入库，见 `.gitignore` 里的说明。
