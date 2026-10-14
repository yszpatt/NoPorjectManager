/**
 * 容器健康检查。
 *
 * 两个坑：
 * 1. `/api/health` 和其它 /api/* 一样要校验令牌，不带令牌会拿到 401。
 * 2. 入口脚本自动生成的令牌只存在于它自己的进程环境里，而健康检查是
 *    Docker 另起的新进程——所以还得从数据目录里的令牌文件兜底读取。
 *
 * 同时覆盖两种启动方式：默认跑看板（PM_UI_PORT），也可以把 CMD 换成
 * MCP(HTTP) 服务（PM_HTTP_PORT），哪种活着就算健康。
 */
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.PM_DATA_DIR ?? '/data';
const uiPort = Number(process.env.PM_UI_PORT ?? 8930);
const mcpPort = Number(process.env.PM_HTTP_PORT ?? 8931);

function token() {
  const fromEnv = (process.env.PM_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(path.join(dataDir, '.token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function probe(url, headers) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const t = token();
const healthy =
  (await probe(`http://127.0.0.1:${uiPort}/api/health`, t ? { 'x-pm-token': t } : {})) ||
  (await probe(`http://127.0.0.1:${mcpPort}/health`, {}));

process.exit(healthy ? 0 : 1);
