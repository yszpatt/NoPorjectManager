#!/usr/bin/env node
/**
 * `pm` 可执行入口：用 tsx 直接运行 TS 源码，无需构建步骤。
 * --disable-warning=ExperimentalWarning 用于屏蔽 node:sqlite 的实验告警，
 * 保证 stdio 模式下 stderr 干净、stdout 纯净。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entry = path.join(root, 'src', 'cli', 'index.ts');

// tsx 内部可能会再派生 node 子进程，用 NODE_OPTIONS 保证标志能穿透继承
const nodeOptions = [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning']
  .filter(Boolean)
  .join(' ');

const result = spawnSync(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', tsx, entry, ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: nodeOptions } },
);

process.exit(result.status ?? 1);
