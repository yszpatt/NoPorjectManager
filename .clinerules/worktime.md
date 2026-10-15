# WorkTime 规则（Cline）

本仓库由 **WorkTime** 初始化。完整规则见仓库根目录 [`AGENTS.md`](../AGENTS.md)，
本文件是给 Cline 的等价摘要，**以 `AGENTS.md` 为准**。

## 必守四条

1. **先取计划再动手**：`pm_get_daily_plan`；只有 `status: none` 时才 `pm_generate_daily_plan`。
2. **进展随时记**：`pm_report_progress(no-project-manager, content, refs={commit: "<sha>"})`。
   `content` = 首行结论 + 分条（`完成`/`调整`/`修复`/`决策`/`卡点`/`问题`/`验证`/`下一步`）。
3. **收尾三件套**：看板 → `warden_publish_brief`（一个任务一条，先 `warden_list_recent` 去重）
   → `speaker_tts`（一句话口语总结）。中间步骤不发不播。
4. **提交规范**：`<type>(<scope>): <中文一句话>`，禁止 `--no-verify`。

## MCP

项目根 `.vscode/mcp.json` 已配好三台服务。若 Cline 读不到，把同样的 JSON 粘进
Cline 的 MCP Servers 配置面板（Cline 的 MCP 设置通常是用户级的，不随仓库走）。

## 体检

```bash
python3 scripts/worktime.py check
```
