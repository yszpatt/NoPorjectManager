# 数据约定

## 存储布局

```
.projectmanager/
├── projects/<id>.md      # 事实源：YAML frontmatter + Markdown 正文
├── events/<id>.jsonl     # 事实源：追加型事件流，一行一个事件
├── plans/<YYYY-MM-DD>.md # 事实源：每日计划
├── config.json           # 配置：健康度阈值、日程策略、自定义字段
└── index.sqlite          # 派生索引，可随时用 `pm reindex` 重建
```

事实源是 Markdown/JSONL，可由人或 Agent 直接编辑；SQLite 仅承担查询与汇总，**不要把它当唯一真相**（它会在文件 mtime 变化时自动重新索引）。

## 项目状态（status）

| 值 | 含义 | 说明 |
|---|---|---|
| `idea` | 只是想法，未启动 | |
| `planning` | 规划中 | |
| `active` | 进行中 | 会参与「计划停滞」推导 |
| `blocked` | **被外部因素卡住**，需要决策或外部依赖 | 看板上以状态徽章表达；**不产生提醒** |
| `paused` | **主动暂停**，有意搁置 | 不产生提醒 |
| `done` | 已完成 | |
| `archived` | 归档，默认不出现在列表 | |

`blocked` 与 `paused` 的区别很重要：前者是"出了问题需要处理"，后者是"我们决定先放一放"。混用会让状态失去信息量。

## 发布记录（release）

发布是这个看板里的一等公民——独立开发最值得留档的事。

- 以 `type: 'release'` 的事件形式落在同一份事件流里，`version` 必填
- `last_release`（版本 / 时间 / 说明 / tag / commit）与 `release_count` 由事件流派生
- 两种来源：`pm_report_release` 手动记录；`pm_sync_git` 自动把命名匹配 `git.releaseTagPattern`（默认 `^v?\d+(\.\d+)*$`）的 tag 采集为发布
- 自动采集的事件 id 是 `release-<tag>`，因此重复同步不会产生重复记录

**语义**：一次发布 = 一个对外可用的新版本。日常提交不算发布，不要为了凑数发版本。

## 提醒规则（config.reminders）

| 配置 | 默认 | 含义 |
|---|---|---|
| `planStalledAfterDays` | 10 | 有未完成计划但超过这么多天没有新记录 → 提醒「计划停滞」（>30 天升级为 `high`） |

**只有这一种提醒。** 进度落后、截止临近、里程碑滑期都不产生提醒——它们需要先维护排期，对"写自用小工具"的场景既不准确也不催生行动。

## 优先级（priority）

`P0` > `P1` > `P2` > `P3`。默认 `P2`。优先级只影响**当日计划的排序权重**，不影响健康度。

## 进度来源模式（config.progress.mode）

| 值 | 行为 | Agent 需要注意 |
|---|---|---|
| `declared`（默认） | 进度取人工/Agent 显式声明的值 | 正常使用 `delta` / `progress` |
| `auto` | 进度 = 路线图里程碑完成度（已完成 1 / 进行中 0.5 / 已放弃不计入） | **不要**再花力气调进度：`pm_report_progress` 的 `delta`/`progress` 只写入事件、不改变展示进度。改进度请改里程碑 `status` |

先调 `pm_get_config` 确认当前模式。返回的项目对象里 `progress_derived: true` 也表示该项目的进度来自自动推导。

切到 `auto` 的正确姿势：把 `roadmap` 拆得足够细（每个里程碑粒度接近），否则进度会跳变。

## 进度（progress）

- 取值范围 0–100 的整数，**必须显式声明**，系统不会从 commit 数或任务数推算
- 是"完成度"的主观判断，不是代码行数或时间消耗的度量
- 变更历史的唯一记录是事件流（`events/*.jsonl`），因此每次调整最好配一句说明
- Git 采集默认**不改写**进度；只有 commit message 中的 `[pm:项目id] +10` 才生效

## 健康度（health，派生字段）

由 `progress`、`status`、`target_date` 与事件流计算得出，不落盘为事实：

| 值 | 判定规则 |
|---|---|
| `blocked` | `status === 'blocked'` |
| `done` | `status` 为 `done` / `archived` |
| `stale` | 非 idea/planning 状态下，`staleAfterDays`（默认 14）天无任何事件；或 `status === 'paused'` |
| `at_risk` | 进度落后于"时间轴预期进度"超过 `atRiskProgressGap`（默认 15）个百分点。预期进度 = 已过时间 / (created_at → target_date) |
| `unknown` | 已 `active` 但进度为 0 且无记录 |
| `on_track` | 以上都不满足 |

阈值可在 `.projectmanager/config.json` 的 `health` 段调整。

## 事件类型（type）

| 值 | 用途 |
|---|---|
| `progress` | 进度变更（通常由 `delta`/`progress` 参数自动判定） |
| `status` | 状态流转（如 `active → blocked`），由 `pm_update_project` 自动产生 |
| `note` | 一般说明、决策记录 |
| `milestone` | 里程碑达成 |
| `blocker` | 登记阻塞（配合 `status: blocked` 使用） |
| `plan` | 计划相关（如计划确认） |

## 事件来源（source）

| 值 | 含义 | 何时产生 |
|---|---|---|
| `agent` | Agent 写入 | 调 MCP 工具；或 CLI / REST 显式声明 `--source agent` / `{"source":"agent"}` |
| `user` | 人工录入 | 看板界面操作；CLI / REST 未声明来源时的默认值 |
| `git` | 采集器 | `pm_sync_git` |
| `integration` | 外部系统 | 预留（Jira / CI 等适配器） |

⚠️ **用 CLI 或 REST 兜底时务必显式声明来源**。这两条路径默认记为 `user`，Agent 直接调用会让看板上把自动化写入标成「人工」，破坏可追溯性：

```bash
node bin/pm.mjs progress <id> "说明" --delta 5 --source agent
```

来源仅用于展示与筛选，**不影响数据语义**——同一项目上不同来源的事件应可共存、可对比。

## id 规范

- 项目 id：小写 ASCII，连字符分隔（如 `pipeline-refactor`）
- 名称含中文时，`slugify` 无法转写会生成随机 id（如 `proj-tqfa`）。**建议创建时显式传 `id`**，以便在 commit message（`[pm:id]`）、CLI 与 URL 中稳定引用
- 目标 id 形如 `g1`、`g2`；路线图条目 id 形如 `r1`、`r2`；任务 id 形如 `t-xxxxx`
- Git 事件 id 固定为 `git-<完整 sha>`，这是采集器幂等的依据

## 自定义字段（扩展）

`config.json` 的 `customFields` 声明字段定义，项目上的 `custom` 对象存放取值：

```json
{
  "customFields": {
    "owner": { "label": "负责人", "type": "string" },
    "budget": { "label": "预算（人天）", "type": "number" },
    "customer": { "label": "客户", "type": "enum", "options": ["A", "B"] }
  }
}
```

写入方式：`pm_create_project` / `pm_update_project` 的 `custom` 参数。字段可被 MCP 客户端、看板 UI 与未来的导出器消费。

## 写入优先级

同一项目的同一事实若出现冲突，按以下顺序取信：

1. 人工在 Markdown / CLI 中的显式编辑（最高）
2. Agent 通过 `pm_report_progress` 的声明
3. Git 采集器的推断（最低）

Git 采集器因此被设计为只影响活跃度，不覆盖 `progress`。
