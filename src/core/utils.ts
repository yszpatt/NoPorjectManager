/** 通用小工具：时间、id、slug、数值。 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function nowIso(): string {
  return new Date().toISOString();
}

/** 本地日期字符串 YYYY-MM-DD */
export function todayStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 把各种 ISO 表示统一成 UTC（Z）形式。
 *
 * 事件流里可能混有 `...Z`（本系统写入）与 `...±HH:MM`（git %aI 原样）两种写法，
 * 直接做字符串比较会得出错误的先后顺序，因此读写时统一归一化。
 */
export function toUtcIso(ts: string): string {
  const t = new Date(ts).getTime();
  return Number.isNaN(t) ? ts : new Date(t).toISOString();
}

/** 取某个时间戳在「本地时区」下所属的日期（YYYY-MM-DD） */
export function localDateStr(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts.slice(0, 10) : todayStr(d);
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return todayStr(d);
}

/** 以天为单位计算 a - b（负数表示 a 早于 b） */
export function daysBetween(a: string | Date, b: string | Date): number {
  const ta = toTime(a);
  const tb = toTime(b);
  return Math.round((ta - tb) / DAY_MS);
}

function toTime(v: string | Date): number {
  if (v instanceof Date) return v.getTime();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00`).getTime();
  return new Date(v).getTime();
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * 生成 ASCII 化的 id：便于在 commit message（[pm:id]）、URL、CLI 中安全使用。
 * 纯中文名称无法转写时回退为随机 id，此时建议显式传入 id。
 */
export function slugify(input: string, fallbackPrefix = 'proj'): string {
  const ascii = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii || `${fallbackPrefix}-${Math.random().toString(36).slice(2, 6)}`;
}

export function newId(prefix = 'e'): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}${rand}`;
}

export function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/** 截断长文本，用于卡片摘要 */
export function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/**
 * 取记录的首行。
 * 记录按「结论 + 分条」书写，首行就是结论，适合放进卡片这类一行摘要的位置。
 */
export function firstLine(s: string): string {
  const [head] = s.split('\n');
  return head.trim();
}

export function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function uniqBy<T, K>(arr: T[], key: (item: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const item of arr) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
