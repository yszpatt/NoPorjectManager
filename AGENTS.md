# NoProjectManager（项目看板） — Agent 工作规则

> 本文件由 **WorkTime** 生成（2026-10-15）。任何在本仓库工作的 Agent 都必须遵守。
> 规则改动请直接改本文件并提交，不要只改某个工具的私有副本。

## 0. WorkTime 托管的三条外设链路

| 链路 | 用途 | 何时用 |
|---|---|---|
| **项目看板** `project-manager` | 提报项目信息、思考、计划、发布 | 会话开始读计划；执行中记进展；发布留档 |
| **Kindle 副屏** `kindle-brief` | 一屏只读的结论展示 | 一个任务**做完**之后，一条 |
| **小爱音箱** `mi-voice-control` | 语音汇报 | 一个任务**做完**之后，一句话 |

固定顺序：**看板 → 副屏 → 语音**。三者都是「任务级」动作，不是「步骤级」。

## 1. 开场：先看计划，再动手

```
pm_get_daily_plan        # 先取今天的计划
```

- 返回 `status: none` 时才调 `pm_generate_daily_plan`
- **不要改写已生成的计划标题** —— 用户可能已手工调整过
- 需要背景时按代价递增：`pm_brief` → `pm_get_feed` → `pm_summary`

## 2. 执行前的约束

- 破坏性操作（删文件、改系统配置、动网络 / 容器、改他人数据）**先给执行计划等确认**
- 只读排查类任务不要顺手改配置
- 每个修复都要在真实环境验证；未验证不得声称完成
- 不把 `.env` 内容、密钥、token 写进日志、提交信息或对外输出

## 3. 提交规范

```
<type>(<scope>): <中文一句话说明>
```

- `type` ∈ `feat` `fix` `refactor` `perf` `docs` `test` `chore`
- 一个逻辑改动一个 commit，不把无关改动混在一起
- 想给看板记进度增量时，commit body 加一行 `[pm:no-project-manager] +N`
  （写了这行就**不要**再调 `pm_report_progress` 累加，会重复计算）
- **禁止** `--no-verify`；hook 失败先修根因
- 已在看板汇报过的改动，commit 时不要重复汇报

## 4. 进展随时记，不要攒到最后

```
pm_report_progress(no-project-manager, content, refs={ commit: "<sha>" })
```

- `content` 的写法：**首行是结论**（一句话，能带数字就带）+ 下面分条
- 每条以标签开头：`完成` / `调整` / `修复` / `决策` / `卡点` / `问题` / `验证` / `下一步`
- **已提交的改动必须带 `refs: { commit: "<sha>" }`**，否则同一件事会在看板上显示成两行
- 思考、方案取舍用 `type: "note"`；被卡住用 `type: "blocker"`
- 一件事一条记录；只写做了什么、不写结果与影响的，重写

## 5. 收尾：三件事，缺一不可

### 5.1 看板

- 有当日任务 → `pm_complete_daily_task(task_id, note)`（会自动回写进展，不必再手动 report）
- 发布了版本 → `pm_report_release(no-project-manager, version, note, url)`，`note` 写「这一版用户能做什么」
- 想清楚下一步 → `pm_upsert_roadmap_item(no-project-manager, title, status)`
  —— **标题必须是动词开头的具体一件事**，`优化性能` / `完善文档` 这类不合格
  —— `status` 只能是 `planned` / `in_progress` / `done` / `dropped`（**没有 `todo`**）
- ⚠️ 本机部署下看板**不能自动采集 git**（容器里没挂仓库目录），
  所以「汇报必须自己带 `refs: { commit: "<sha>" }`」不是可选项 —— 不带就等于没关联

### 5.2 Kindle 副屏

```
warden_list_recent()          # 先去重
warden_publish_brief(title, status, summary, project="no-project-manager")
```

- **一个任务最多一条**。中间步骤、纯查询、单文件编辑**不发**
- `title` ≤ 20 个中文字，写**结论**不写过程
- `summary` 看板视图只显示前 28 字，第一句必须独立成句
- 同一任务的后续更新用 `supersedes: "<brief_id>"`，不要追加第二条
- 不写密钥 / 私人信息 / 大段代码 / 内部主机名

### 5.3 小爱音箱

```
speaker_tts(text="一句话口语总结：做了什么、结果如何、下一步")
```

- 只面向用户本人，口语化，**不堆技术细节**（不要说工具名、文件名、行号）
- 任务失败或需要介入时同样要播，说清卡在哪

### 5.4 什么时候**不要**播报

- 中间步骤
- 纯信息查询（读文件、搜索、浏览）
- 与上一条同一任务的连续小改动 → 合并

## 6. 环境约定

- `.env` 进 `.gitignore`；只提交 `.env.example`
- 环境变量优先于 `.env` 文件
- npm / pnpm 走国内镜像（`https://registry.npmmirror.com`）
- 见到明文密钥被贴进对话 / 提交时，主动提醒轮换

## 7. 服务地址

| 服务 | 地址 | 凭据 |
|---|---|---|
| 项目看板 | `http://192.168.9.57:8930` | Basic `pm:***`（见 `.env`） |
| Kindle 副屏 | `http://192.168.9.57:8577` | 无 |
| 小爱音箱 | `http://192.168.9.57:3001` | 无 |

排查命令：

```bash
python3 scripts/worktime.py check      # 三个服务 + MCP 握手一次性体检
```

---

WorkTime 由 `~/Project/worktime`（私有仓库 `yszpatt/WorkTime`）提供。
