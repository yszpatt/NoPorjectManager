import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface Doc {
  data: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseDoc(raw: string): Doc {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { data: {}, body: raw.trim() };
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = parseYaml(m[1] ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }
  return { data, body: raw.slice(m[0].length).trim() };
}

/**
 * 序列化为「YAML frontmatter + Markdown 正文」。
 * 传入的 data 键顺序即输出顺序，便于 git diff 稳定。
 */
export function stringifyDoc(data: Record<string, unknown>, body: string): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    clean[k] = v;
  }
  const fm = stringifyYaml(clean, {
    lineWidth: 0,
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
    nullStr: '',
  }).trimEnd();
  const b = (body ?? '').replace(/^\s*\n+/, '').trimEnd();
  return `---\n${fm}\n---\n\n${b}\n`;
}

/** 保证数组在 frontmatter 中始终是块状列表（可读性与 diff 友好） */
export function stringifyList(values: string[]): string[] {
  return values.length ? values : [];
}
