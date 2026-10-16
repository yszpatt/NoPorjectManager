# MCP 工具速查

所有工具名以 `pm_` 开头。返回值为 JSON 文本；出错时以 `isError` 标记并返回可读错误信息（如 `项目不存在: xxx`），不会抛协议异常。

写入类工具只返回**精简回执**（`id` / `status` / `progress` / `updated_at`，另加本次改动的关键字段，如 `item_id` / `goal_id` / `release_count` / `changed`），**不回显整个项目对象**——这是为了控制上下文开销。需要完整字段时显式调用 `pm_get_project`。

## 查询类（只读）

### `pm_list_projects`
按条件筛选项目。默认返回**精简卡片**（省上下文）。

| 参数 | 类型 | 说明 |
|---|---|---|
| `status` | string[] | `idea`/`planning`/`active`/`blocked`/`paused`/`done`/`archived` |
| `health` | string[] | `on_track`/`at_risk`/`stale`/`blocked`/`done`/`unknown` |
| `priority` | string[] | `P0`~`P3` |
| `tags` | string[] | 任一命中即返回 |
| `query` | string | 匹配名称/描述/正文/标签 |
| `include_archived` | boolean | 默认 `false` |
| `limit` | number | 截断条数 |
| `detail` | `card` \| `full` | 默认 `card`；`full` 返回完整字段（不含正文） |

卡片字段分两类。

**信息主体**（看板卡片展示）：`id / name / description / status / priority / tags / health / health_reason / momentum / event_count / days_since_activity / updated_at / plans / open_plans / updates / reminder`。

- `plans`：**最多 3 条**未完成的未来规划 `{ title, due?, status }`，排序为「进行中 → 有日期（近的在前）→ 其余」。`due` 不保证存在——进行中的规划常常未排期
- `open_plans`：未完成规划总数。卡片要显示「还有 N 条」时用 `open_plans - plans.length`
- `updates`：**最近 3 条**记录 `{ source, type, ts, content }`；`content` 只保留首行结论（截断 90 字）
- `reminder`：计划停滞提醒；没有命中为 `null`

**给表格视图 / 详情页 / Agent 用**：`last_release / release_count / progress / progress_derived / target_date / days_to_target / goals / open_goals`。

- `last_release` / `release_count`：最近一次发布与累计次数。**卡片上已不展示**
- `progress` / `target_date` / `goals` 等同样不上卡片，需要时读它们即可

### `pm_get_project`
读项目详情。

- `id`（必填）
- `timeline_limit`（默认 15，回看更早历史时显式传大）：附带最近事件条数

返回完整字段 + `timeline` 数组（`ts / source / type / content / delta / actor / refs`）。

### `pm_summary`
无参数。返回全局汇总：`totals`（projects/active/archived/avg_progress）、`by_status`、`by_health`、`at_risk`、`stale`、`blocked`、`upcoming`（30 天内截止）、`today_plan`。

### `pm_timeline`
- `id`（必填）、`limit`（默认 50）

只要事件流、不要项目字段时用它，比 `pm_get_project` 轻。

### `pm_brief`
- `date`（可选，默认今天）

返回 Markdown 简报：总览 + 滞涨 + 今日计划。适合直接注入上下文或展示给用户。

### `pm_get_feed`
- `limit`（默认 30）、`project_id`（可选）、`types`（可选，如 `["release","note"]`）

跨项目动态流：按时间倒序读取所有项目的记录。用于回答「最近都在忙什么」，也适合在总结某段时间的工作前先拉一遍。

### `pm_check_reminders`
- `stalled_days`（可选，默认取配置的 `reminders.planStalledAfterDays`）、`min_level`（默认 `low`）

检查「计划停滞」：哪些项目有明确想做的事、但已经很久没有新记录。**只看后续计划与记录活跃度**，不涉及进度、截止或排期。`kind` 只有 `plan_stalled` 与 `no_plan` 两种。

## 项目增删改

### `pm_create_project`
| 参数 | 说明 |
|---|---|
| `name` | 必填 |
| `id` | 建议显式指定（ASCII），中文名称会自动生成随机 id |
| `description` | 一句话简介（卡片与列表用） |
| `status` / `progress` / `priority` / `tags` / `target_date` | 常规字段 |
| `goals[]` | `{ id?, title, metric?, target?, current?, due?, status? }` |
| `roadmap[]` | `{ id?, title, due?, status?, description? }` |
| `repos[]` | `{ path?, url?, branch? }`，关联后即可被 Git 采集器扫描 |
| `body` | Markdown 正文（详细介绍/方案），不传则按 description 生成 |

### `pm_update_project`
局部更新，只需传要改的字段：`id` + 任意 `name`/`description`/`status`/`progress`/`priority`/`tags`/`target_date`/`custom`/`body`。

`status` 与 `progress` 的变更会自动写入时间线事件，**不要**再单独调 `pm_report_progress` 重复记录。

`target_date: null` 表示清除截止日期。

### `pm_delete_project`
- `id`（必填）、`hard`（默认 `false` = 归档）

默认归档会保留全部历史；`hard: true` 才真正删除项目文件与事件流。**除非用户明确要求删除，一律用归档。**

## 进展与规划

### `pm_report_release`
记录一次版本发布（`version` 必填）。独立开发里发布是最值得留档的事件：之后随时能回答「最后一次发布是什么版本、什么时候、包含什么」。

仓库已关联时，命名符合版本号规范的 git tag 会被 `pm_sync_git` 自动采集为发布，不必手工记录。

### `pm_report_progress`
最常用的写入入口。

> 若 `config.progress.mode = 'auto'`，`progress` / `delta` 只记录成事件，不会改变展示进度（进度由里程碑推导）。此时应改为切换里程碑 `status`。见 `conventions.md`。

| 参数 | 说明 |
|---|---|
| `id` | 必填 |
| `content` | 必填，写结论 |
| `progress` | 绝对百分比，优先于 `delta` |
| `delta` | 增量，如 `+10` / `-5` |
| `type` | `progress`/`status`/`note`/`milestone`/`blocker`/`plan`；不传时按是否带进度自动判定 |
| `actor` | 操作者标识 |
| `refs` | `{ commit, session, file, ... }` |

### `pm_upsert_goal`
`id`（项目） + `goal_id`（传则更新，不传则新增） + `title`/`metric`/`target`/`current`/`due`/`status`。

新增时必须给 `title`；更新时可只给 `goal_id` 与要改的字段。

### `pm_upsert_roadmap_item`
`id`（项目） + `item_id`（传则更新） + `title`/`due`/`status`/`description`。

新增时必须给 `title`。新增条目会按 `due` 自动排序。

### `pm_link_repo`
- `id` + `path`（本地仓库绝对路径，可被采集）或 `url`（仅记录）
- `branch`：指定分支，默认 HEAD
- `unlink: true`：解绑

## 每日计划

### `pm_generate_daily_plan`
- `date`（默认今天）、`max_tasks`（默认取配置 `planning.maxTasksPerDay`，初始为 5）
- `replace`（默认 `false`）：`true` 会丢弃已有未完成任务
- `focus`：今日额外关注点，写入计划摘要

默认保留「已完成任务」与「人工添加的任务」，仅补充新推导出的任务；同一项目最多采纳 2 条。

### `pm_get_daily_plan`
- `date`（默认今天）

无计划时返回 `status: "none"`，此时才调 `pm_generate_daily_plan`。

### `pm_upsert_daily_task`
- `date`（默认今天）
- 传 `task_id` 则更新该任务（按 id 或标题匹配），否则新增
- `title`（必填）、`project_id`、`status`、`estimate`、`rationale`

### `pm_complete_daily_task`
- `task_id`（必填，id 或标题）、`date`、`note`、`delta` / `progress`、`actor`

标记完成的同时向所属项目回写进展事件。返回 `completed`、`plan_status`、`remaining`。

## 集成与配置

### `pm_sync_git`
- `project_id`（可选，省略则同步全部非归档项目）
- `since`（ISO 时间，省略则从上次 Git 事件起算）
- `max_commits`（默认 200）

幂等：同一 commit 不会重复写入（以 `git-<sha>` 为事件 id 去重）。

### `pm_get_config` / `pm_update_config`
`pm_update_config` 接受 `patch` 对象，与现有配置**深合并**：

```json
{ "health": { "staleAfterDays": 21 }, "planning": { "maxTasksPerDay": 6 } }
```

可用于调整阈值、注册自定义字段、开关适配器。

## MCP 资源

| URI | 内容 |
|---|---|
| `pm://brief/today` | 今日简报（text/markdown） |
| `pm://summary` | 全局汇总（application/json） |
