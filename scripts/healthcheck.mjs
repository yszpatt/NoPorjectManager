/**
 * 容器健康检查。
 *
 * 看板与 MCP 在同一个端口上，所以只需要探一个地址：
 * 1. 先带 Basic 凭据探 `/api/health` —— 它会读取数据目录与项目数，能验证数据层。
 * 2. 口令拿不到时退回到免认证的 `/health` —— 只证明进程活着。
 *
 * 凭据为什么不能只读环境变量：入口脚本自动生成的口令只存在于它自己的进程环境里，
 * 而健康检查是 Docker 另起的新进程，所以还得从数据目录里的口令文件兜底读取。
 */
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.PM_DATA_DIR ?? '/data';
const port = Number(process.env.PM_UI_PORT ?? 8930);
const base = `http://127.0.0.1:${port}`;

function readFile(name) {
  try {
    return fs.readFileSync(path.join(dataDir, name), 'utf8').trim();
  } catch {
    return '';
  }
}

/** `Authorization: Basic …`；没有口令时返回空串（服务端未启用认证） */
function basicAuth() {
  const user = (process.env.PM_USER ?? 'pm').trim() || 'pm';
  const password =
    (process.env.PM_PASSWORD ?? process.env.PM_TOKEN ?? '').trim() ||
    readFile('.password') ||
    readFile('.token');
  return password ? `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` : '';
}

async function probe(url, headers) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const auth = basicAuth();
const healthy =
  (auth ? await probe(`${base}/api/health`, { authorization: auth }) : false) ||
  (await probe(`${base}/health`, {}));

process.exit(healthy ? 0 : 1);
