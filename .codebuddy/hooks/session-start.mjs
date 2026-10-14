#!/usr/bin/env node
/**
 * SessionStart hook：把当日简报注入会话上下文。
 *
 * 设计约束：
 * - 永远以 0 退出，任何异常都不得阻断会话
 * - 未初始化看板（无 .projectmanager）时静默退出，避免给无关项目刷屏
 * - 只输出裁剪过的简报，避免污染上下文
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let ran = false;

function run() {
  if (ran) return;
  ran = true;
  try {
    const root = process.env.CODEBUDDY_PROJECT_DIR || process.cwd();
    if (!fs.existsSync(path.join(root, '.projectmanager', 'projects'))) return;

    const entry = path.join(root, 'bin', 'pm.mjs');
    if (!fs.existsSync(entry)) return;

    const result = spawnSync(process.execPath, [entry, 'brief'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 12000,
    });
    const out = (result.stdout || '').trim();
    if (!out) return;

    process.stdout.write(`## 项目看板 · 今日简报\n\n${out}\n`);
    process.stdout.write(
      '\n> 可用 pm_get_daily_plan 读取计划、pm_report_progress 汇报进展、pm_complete_daily_task 收尾；详见 project-manager Skill。\n',
    );
  } catch {
    /* 静默失败，绝不阻断会话 */
  }
}

// 排空 stdin（hook 会传入 JSON），避免上游写管道时阻塞
try {
  process.stdin.resume();
  process.stdin.on('data', () => {});
  process.stdin.on('error', () => {});
} catch {
  /* ignore */
}

setTimeout(() => {
  run();
  process.exit(0);
}, 50);
