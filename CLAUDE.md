# NoProjectManager（项目看板）

> 本仓库是 **WorkTime** 托管的项目。规则正文只有一份：**[`AGENTS.md`](./AGENTS.md)** —— 开工前先读它。
> 本文件只补充 Claude Code 特有的东西。

## 快捷命令

```bash
python3 scripts/worktime.py check      # 三个外设服务 + MCP 握手体检
```

## MCP 接入

项目根 `.mcp.json` 已配好三台服务（`project-manager` / `kindlewarden` / `mi-voice`）。
若 Claude Code 提示 MCP 未授权，在会话里执行 `/mcp` 查看并批准项目级服务器。

## 收尾三件套（每个任务做完必做）

1. 看板：`pm_report_progress` 或 `pm_complete_daily_task`
2. Kindle：`warden_publish_brief`（一个任务一条）
3. 小爱：`speaker_tts`（一句话口语总结）

细节与禁令见 `AGENTS.md` 第 5 节。
