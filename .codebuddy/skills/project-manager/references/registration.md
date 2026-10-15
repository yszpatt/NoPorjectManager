# 接入方式：MCP 与 Hooks

## 一、注册 MCP 服务

服务名建议用 `project-manager`，注册后工具名会变成 `mcp__project-manager__pm_xxx`。

### 方式 A：stdio（推荐，本地 Agent / harness 直连）

```
command: node
args:    ["<项目绝对路径>/bin/pm.mjs", "mcp", "stdio"]
```

`bin/pm.mjs` 内部用 tsx 直接运行 TS 源码，无需构建。等价于 `npm run mcp:stdio`。

### 方式 B：HTTP（多 Agent 共享、跨进程访问）

看板 UI、REST API 与 MCP **在同一个服务、同一个端口上**，启动一次就够：

```bash
npm run serve           # → http://localhost:8930/ ，MCP 端点在 /mcp
```

再以 URL 方式注册：

```
url: http://localhost:8930/mcp
```

**若该服务开了访问口令（`--password` / 容器部署），HTTP 注册必须带上同一套 Basic 凭据**，否则 MCP 请求会拿到 401：

```
headers: { "Authorization": "Basic <base64(pm:口令)>" }
```

无状态模式（每个请求独立），便于多个 Agent 并发访问同一份数据。

可用环境变量调整：`PM_UI_PORT`（默认 8930）、`PM_HTTP_PATH`（默认 `/mcp`）、`PM_MCP=0`（关闭 MCP 端点）。健康检查：`GET /health`（免认证，只回存活状态）。

> 只想给 MCP 开一个端口、不给看板 UI 时，用 `npm run mcp:http` 起独立模式：默认 `http://localhost:8931/mcp`，**没有任何鉴权**，请只绑回环。可用 `PM_HTTP_PORT` 调整端口。

### 在 CodeBuddy IDE 中注册

打开设置面板的 **MCP** 标签页，添加一个新的 MCP Server，按上面任一种方式填入 command/args 或 URL。

> 若你使用 Claude-Code 兼容的客户端，也可以写入其 `mcpServers` 配置：
> ```json
> {
>   "mcpServers": {
>     "project-manager": {
>       "command": "node",
>       "args": ["<项目绝对路径>/bin/pm.mjs", "mcp", "stdio"]
>     }
>   }
> }
> ```
> 请以你所用客户端的文档为准；不同客户端对配置文件路径有各自约定。

## 二、Hooks（harness 自动化）

配置文件：项目根目录 `.codebuddy/settings.json`（用户级为 `~/.codebuddy/settings.json`）。

> **重要**：CodeBuddy 的 `/hooks` 面板是权威入口。直接编辑 settings.json 后，需要在面板中确认/启用才会生效。请在会话中执行 `/hooks` 检查注册状态。

当前仓库内置了两条 hook：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CODEBUDDY_PROJECT_DIR}/.codebuddy/hooks/session-start.mjs\"",
            "timeout": 15
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CODEBUDDY_PROJECT_DIR}/.codebuddy/hooks/session-end.mjs\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

两条 hook 的职责：

| Hook | 脚本 | 行为 |
|---|---|---|
| `SessionStart` | `.codebuddy/hooks/session-start.mjs` | 若 `.projectmanager/` 已存在，把今日简报打印到 stdout，作为会话上下文；否则静默退出 |
| `SessionEnd` | `.codebuddy/hooks/session-end.mjs` | 执行 `pm git sync`，把新采集到的 commit 数写到 stderr，实现"提交自动进入时间线" |

设计约定：

- 两个脚本**永远 `exit 0`**，任何异常都被吞掉，绝不阻断会话
- 输出都经过裁剪（会话开始只给简报，会话结束只给一行统计），避免噪声进入上下文
- Windows 下 hook 命令经 **Git Bash** 执行，因此命令只使用 node 绝对路径与 POSIX 兼容写法（`"${VAR}"` 双引号包裹）

### 自定义扩展

- 想在每次工具调用后自动记录进展：把 `PostToolUse` 的 matcher 设为 `mcp__project-manager__pm_report_progress`，脚本里从 stdin 读取 `.tool_input` 做审计
- 想禁止 Agent 误删项目：`PreToolUse` + matcher `mcp__project-manager__pm_delete_project`，脚本 `process.exit(2)` 即可阻止调用
- 想接入外部系统（Jira/Linear 等）：订阅领域事件总线（`src/core/events.ts` 的 `onEvent`），在适配器目录新增实现后于 `config.json` 的 `adapters.sources` 中登记

## 三、看板界面

```bash
npm --prefix web install
npm run ui:build     # 构建前端
npm run ui           # http://localhost:8930
```

界面与 MCP/CLI 读写同一份 Markdown 事实源，因此 Agent 的写入会立刻反映在看板上，反之亦然。开发前端时用 `npm run ui:dev`（Vite，8933 端口，`/api` 自动代理到 8930）。

服务默认只监听 `127.0.0.1`。需要从其它设备访问时用 `pm serve --lan`（可选 `--password <口令>` 开启 HTTP Basic 认证，浏览器首次打开会弹原生登录框；MCP 端点共用同一套凭据）。**若为局域网模式且未设口令，看板数据对同网络所有人可写可删**，告知用户前请确认这是他的意图。

口令也可以让用户自己改：**看板顶栏 `⋯` → 设置 → 访问鉴权**。面板凭据落在 `.projectmanager/auth.json`（只存 scrypt 派生值），**优先于 `PM_PASSWORD`**，保存后立即生效。用户改了口令导致 HTTP 注册的 MCP 拿不到数据时，先确认是不是这里改过——注册信息里的 `Authorization` 要跟着换。忘了口令用 `pm auth reset` 清除，回落到环境变量。

## 四、CLI（无 MCP 时的兜底）

```bash
node bin/pm.mjs list                 # 项目列表
node bin/pm.mjs brief                # 今日简报
node bin/pm.mjs summary              # 全局汇总
node bin/pm.mjs reminders --min-level medium
node bin/pm.mjs feed --limit 30
node bin/pm.mjs plan generate        # 生成当日计划
node bin/pm.mjs task done <taskId> --delta 5
node bin/pm.mjs progress <id> "说明" --delta 10 --source agent   # Agent 兜底时必须加 --source agent
node bin/pm.mjs git sync
node bin/pm.mjs reindex              # 手工编辑 Markdown 后重建索引
```

`node bin/pm.mjs help` 查看全部命令。
