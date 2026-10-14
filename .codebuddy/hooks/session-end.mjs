#!/usr/bin/env node
/**
 * SessionEnd hook：自动采集 git commit 到项目时间线。
 *
 * 设计约束：
 * - 永远以 0 退出
 * - 只在「真的采集到新事件」时输出一行到 stderr，保持安静
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
    const config = path.join(root, '.projectmanager', 'config.json');
    if (!fs.existsSync(config)) return;

    // 尊重配置开关
    try {
      const cfg = JSON.parse(fs.readFileSync(config, 'utf8'));
      if (cfg?.git?.enabled === false) return;
    } catch {
      /* 配置损坏时继续尝试同步 */
    }

    const entry = path.join(root, 'bin', 'pm.mjs');
    if (!fs.existsSync(entry)) return;

    const result = spawnSync(process.execPath, [entry, 'git', 'sync'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 25000,
    });
    const raw = (result.stdout || '').trim();
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed.events_created > 0) {
      process.stderr.write(
        `[project-manager] 已从 git 采集 ${parsed.events_created} 条进展事件（${parsed.commits_seen} 个提交被扫描）\n`,
      );
    }
  } catch {
    /* 静默失败，绝不阻断会话 */
  }
}

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
