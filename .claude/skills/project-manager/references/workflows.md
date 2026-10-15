# 工作流

## 一、每日计划（会话开始）

### 触发
会话开始、用户问"今天做什么/现在该做什么"、或被 hooks 唤醒时。

### 步骤

1. 读取已有计划，不重复生成：

   ```
   pm_get_daily_plan
   ```

2. 若返回 `status: "none"`，先生成：

   ```
   pm_generate_daily_plan(max_tasks: 5)
   ```

   生成器**只看后续计划**，每个项目恰好产出一条候选，命中顺序为「计划停滞 > 进行中的计划 > 打算开始的计划 > 没有计划（元任务）」，并给每条任务附上 `rationale`。

3. 需要全局视图时补充调用（可选）：

   ```
   pm_summary                              # 数量/进度分布/活跃度
   pm_get_feed(limit: 20)                  # 最近都在忙什么
   pm_check_reminders(min_level: "medium") # 哪些想法停滞了
   ```

4. 向用户呈现时：**保留 rationale**，它解释了"为什么今天做这件事"。若计划里出现的多是"为 X 写下下一步打算做什么"，说明看板缺少后续计划，应先走工作流二补齐 `roadmap`，而不是硬凑任务。

5. 计划需要用户确认：`pm_generate_daily_plan` 产出的状态是 `proposed`。用户认可后再推进状态：

   ```bash
   node bin/pm.mjs plan status active     # 用户确认后
   node bin/pm.mjs plan status closed     # 当天结束时
   ```

   > 看板「今日」视图里也有「确认计划」按钮。若用户已手工改过任务内容，不要重新生成覆盖；`replace: false`（默认）会保留已完成与人工添加的任务。

### 反例
- 不要为每个项目都生成一条任务——`max_tasks` 默认 5，超出说明需要用户做取舍
- 不要在用户只想"看看进展"时顺手生成计划，避免污染 `plans/` 目录

---

## 二、进展汇报（执行过程中 / 会话收尾）

### 触发
完成一个可描述的阶段性工作、做了重要决策、遇到阻塞、会话即将结束。

### 步骤

1. 定位项目：

   ```
   pm_list_projects(query: "关键词")
   ```

   找不到项目时先登记（见工作流三），不要往无关项目上硬记。

2. 记录进展，**一次调用同时写事件与修正进度**：

   ```
   pm_report_progress(
     id: "pipeline-refactor",
     content: "双写灰度切流 30%，P99 延迟从 480ms 降到 210ms",
     delta: 10,
     refs: { commit: "f6488b9" }
   )
   ```

3. 阻塞场景：

   ```
   pm_report_progress(id, content: "等待 DBA 审批建表", type: "blocker")
   pm_update_project(id, status: "blocked")
   ```

   阻塞解除后记得把 `status` 改回 `active`，否则会一直占用风险列表。

4. 阶段性成果同步进规划：

   ```
   pm_upsert_roadmap_item(id, item_id: "r1", status: "done")
   ```

### 反例
- 每改一个文件就汇报一次 → 事件流变成噪声。以"可对外描述的结果"为粒度
- 只更新 `progress` 不写 `content` → 三个月后无法解释进度为什么变化

---

## 三、项目登记（新项目出现时）

### 触发
用户提到一个新项目、开始在一个未登记的仓库工作、跨会话继续一项工作。

### 步骤

1. 先查重：

   ```
   pm_list_projects(query: "关键词", include_archived: true)
   ```

2. 创建，**显式给 ASCII id**（中文名称会自动生成随机 id，后续引用不便）：

   ```
   pm_create_project(
     id: "pipeline-refactor",
     name: "数据管线重构",
     description: "把批处理管线切换到流式架构",
     status: "active",
     priority: "P0",
     target_date: "2026-10-20",
     roadmap: [
       { id: "r1", title: "双写灰度", due: "2026-10-15" },
       { id: "r2", title: "下线旧链路", due: "2026-10-30" }
     ]
   )
   ```

3. 关联仓库以启用自动采集：

   ```
   pm_link_repo(id: "pipeline-refactor", path: "c:/workspace/pipeline")
   pm_sync_git(project_id: "pipeline-refactor")
   ```

4. 至少留一条**未完成的 roadmap**（`due` 可省），否则每日计划推导不出具体动作。想清楚了就立刻记下来，不要等排期确定。

---

## 四、停滞巡检

### 触发
用户问"项目怎么样 / 最近在忙什么 / 有什么要处理的"、周期性检查。

### 步骤

1. 先看全局：

   ```
   pm_get_feed(limit: 30)                  # 最近实际发生了什么
   pm_check_reminders(min_level: "medium") # 哪些想法停滞了
   ```

2. 按 `kind` 处理：

   | kind | 含义 | 处理方式 |
   |---|---|---|
   | `plan_stalled` | 有未完成的后续计划，但超过阈值没记录 | 问用户：这条计划还想要吗？要就推进（可改成 `in_progress` 并拆出今日任务），不要就改掉 |
   | `no_plan` | 活跃项目既没有未完成计划，也很久没记录 | 先和用户聊清楚"下一步打算做什么"，再补一条 roadmap |

3. 汇报时给出**建议动作**而非仅罗列问题——`suggestion` 字段就是为此准备的。

> 不要分析进度落后、截止临近、里程碑滑期——这些需要先维护排期，不是这个看板的关注点，提出来只会制造噪声。

---

## 五、Git 采集（自动 / 手动）

### 触发
会话结束（由 hook 自动触发）、用户要求同步提交记录。

### 步骤

1. ```
   pm_sync_git(project_id: "videorag")
   ```

   同时采集两类信息：commit → 记录与活跃度；**命名符合版本号规范的 tag → 发布记录**（`release-<tag>` 事件，天然幂等）。这个仓库扫完后不要重复扫描——重复调用是安全的（去重靠事件 id）。

2. 需要进度随提交联动时，在 commit message 中声明：

   ```
   feat: 完成双写灰度 [pm:pipeline-refactor] +10
   ```

   规则：`[pm:<项目id>]` + 可选的 `+N` / `-N`。标签指向**其它项目**的提交会被本项目的同步跳过（由对应项目自己的同步处理）。

3. 避免重复计数：已用 `[pm:id] +N` 声明过的提交，不要再调 `pm_report_progress` 累加同一笔进度。

### 边界
- Git 只影响 `last_activity_at` 与 `momentum`，不覆盖人工声明的 `progress`
- 远程仓库（只有 `url`）暂不采集，同步结果会在 `warnings` 中说明
