import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Paths } from './paths.ts';

/**
 * 在看板面板里设置的访问凭据。
 *
 * 只落盘 **scrypt 派生值 + 随机盐**，不存明文：`.projectmanager/` 默认不入库，
 * 但用户可以选择把它纳入版本控制（见 .gitignore 里的注释），明文口令一旦进去
 * 就再也抹不掉了。
 */
export interface AuthRecord {
  version: 1;
  user: string;
  /** base64 随机盐 */
  salt: string;
  /** base64 scrypt(password, salt, 64) */
  hash: string;
  updated_at: string;
}

const KEY_LEN = 64;
/** 口令最短长度：纯本地工具，不追求复杂度，但拒绝空口令与 123456 */
export const MIN_PASSWORD_LENGTH = 6;

function derive(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LEN);
}

/** 定长比较（先摘要，长度不同也不会提前返回） */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export function authFilePath(paths: Paths): string {
  return path.join(paths.dataDir, 'auth.json');
}

/** 读取面板凭据；文件不存在或格式不对都返回 null（回落到环境变量） */
export function loadAuth(paths: Paths): AuthRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(authFilePath(paths), 'utf8')) as Partial<AuthRecord>;
    if (
      typeof raw.user !== 'string' ||
      raw.user === '' ||
      typeof raw.salt !== 'string' ||
      typeof raw.hash !== 'string'
    ) {
      return null;
    }
    return {
      version: 1,
      user: raw.user,
      salt: raw.salt,
      hash: raw.hash,
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
    };
  } catch {
    return null;
  }
}

/** 写入凭据。口令只以派生值落盘，明文用完即弃。 */
export function saveAuth(paths: Paths, user: string, password: string): AuthRecord {
  const salt = randomBytes(16);
  const record: AuthRecord = {
    version: 1,
    user,
    salt: salt.toString('base64'),
    hash: derive(password, salt).toString('base64'),
    updated_at: new Date().toISOString(),
  };
  fs.mkdirSync(paths.dataDir, { recursive: true });
  // 0600：Linux / 容器里只有属主可读写（Windows 上权限语义有限，聊胜于无）
  fs.writeFileSync(authFilePath(paths), `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return record;
}

/** 清除面板凭据，让服务回落到环境变量（或不再校验） */
export function clearAuth(paths: Paths): void {
  try {
    fs.rmSync(authFilePath(paths), { force: true });
  } catch {
    /* 本来就不存在 */
  }
}

/** 校验用户名与口令；两个都比较完再返回，避免短路暴露「用户名是否正确」 */
export function verifyAuth(record: AuthRecord, user: string, password: string): boolean {
  const salt = Buffer.from(record.salt, 'base64');
  const expected = Buffer.from(record.hash, 'base64');
  const actual = derive(password, salt);
  const userOk = constantTimeEqual(user, record.user);
  const passOk = expected.length === actual.length && timingSafeEqual(expected, actual);
  return userOk && passOk;
}
