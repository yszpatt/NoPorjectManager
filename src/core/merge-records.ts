/**
 * 记录合并：把 git 采集到的提交并入对应的汇报记录。
 *
 * 背景：同一件事常常既留下提交、又被 Agent 汇报一次。两条都是事实，分开看就是重复——
 * 在同一件事上刷两行，看板立刻变噪音。
 *
 * 做法：事实源仍是 append-only 的原始事件（提交是事实，汇报是叙述），
 * 合并只发生在**读取时**。因此不丢原始数据，重建索引也能得到同样的结果。
 *
 * 关联方式两种：
 * 1. 显式：汇报里写 `refs.commit` / `refs.commits`（可靠，Skill 要求这么做）
 * 2. 自动：同项目、时间窗口内**一对一**的提交与汇报（保守，拿不准就不并）
 */
import type { Update } from './types.ts';

export interface LinkedCommit {
  sha: string;
  /** 原始提交标题，便于核对合并是否正确 */
  subject?: string;
}

export interface MergedRecord extends Update {
  /** 被并入本条记录的提交。本条自身若是提交记录，则不含自己 */
  commits: LinkedCommit[];
}

export interface MergeOptions {
  /** 自动配对的时间窗口（分钟）。<=0 表示只认显式声明的 refs.commit */
  windowMinutes?: number;
}

const GIT_PREFIX = 'git-';
/** sha 允许以短形式出现，太短容易误配 */
const MIN_SHA = 7;

/** git 采集事件的 id 形如 `git-<sha>`，取出其中的 sha */
export function commitIdOf(e: Update): string | undefined {
  return e.source === 'git' && e.id.startsWith(GIT_PREFIX)
    ? e.id.slice(GIT_PREFIX.length)
    : undefined;
}

/** 汇报里显式声明的提交。`refs.commit` 与 `refs.commits` 都支持，后者可用逗号或空格分隔多个 */
export function declaredCommits(e: Update): string[] {
  return [e.refs?.commit, e.refs?.commits]
    .filter((v): v is string => Boolean(v))
    .flatMap((v) => v.split(/[\s,]+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 前缀匹配：记录里可能是 7 位短 sha，也可能是完整 40 位 */
function sameCommit(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  return n >= MIN_SHA && a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
}

/** 适合作为合并宿主的记录：人/Agent 写的、有叙述内容的 */
function canHost(e: Update): boolean {
  if (e.source === 'git') return false;
  if (e.auto === true) return false;
  if (e.type === 'release') return false;
  return true;
}

/**
 * 合并记录。返回的数组里，被并入的提交不再单独出现，
 * 其宿主记录带上 `commits`（并保留原有的 source / 内容 / 时间）。
 */
export function mergeRecords(events: Update[], opts: MergeOptions = {}): MergedRecord[] {
  const windowMs = Math.max(0, opts.windowMinutes ?? 0) * 60_000;

  /** 提交事件：sha → 事件 */
  const commitsBySha = new Map<string, Update>();
  /** 非提交事件，按原顺序保留 */
  const others: Update[] = [];
  for (const e of events) {
    const sha = commitIdOf(e);
    if (sha) commitsBySha.set(sha, e);
    else others.push(e);
  }

  const merged = new Map<string, LinkedCommit[]>();
  const absorbed = new Set<string>();
  /** 宿主 → 从提交带过来的增量（宿主自己没写增量时才用） */
  const deltaFromCommit = new Map<string, number>();

  /** 找到某个 sha 对应的、尚未被并走的提交事件 */
  const findCommit = (sha: string): [string, Update] | undefined =>
    [...commitsBySha.entries()].find(([s, g]) => !absorbed.has(g.id) && sameCommit(s, sha));

  /** 提交并入宿主：宿主保留自己的叙述，提交以 sha 挂上去 */
  const attach = (host: Update, git: Update, sha: string) => {
    const subject = git.refs?.subject;
    const list = merged.get(host.id) ?? [];
    list.push({ sha, ...(subject ? { subject } : {}) });
    merged.set(host.id, list);
    absorbed.add(git.id);
    // 宿主没写增量、而提交声明了增量（`[pm:x] +10`）时，把增量带过来
    if (host.delta === undefined && git.delta !== undefined) {
      deltaFromCommit.set(host.id, git.delta);
    }
  };

  /** 审计事件并入提交：方向与上面相反 */
  const absorbIntoCommit = (git: Update, audit: Update) => {
    absorbed.add(audit.id);
    if (git.delta === undefined && audit.delta !== undefined) {
      deltaFromCommit.set(git.id, audit.delta);
    }
  };

  // ---- 1) 显式关联
  for (const o of others) {
    const shas = declaredCommits(o);
    if (!shas.length) continue;

    if (o.auto === true) {
      // 系统审计事件只是提交的注解（`进度 0% → 10%`），方向要反过来：
      // 让它并进提交，提交那一条保持干净——否则看板上会顶着一句机器文案
      for (const sha of shas) {
        const hit = findCommit(sha);
        if (hit) absorbIntoCommit(hit[1], o);
      }
      continue;
    }

    for (const sha of shas) {
      if (merged.get(o.id)?.some((c) => sameCommit(c.sha, sha))) continue;
      const hit = findCommit(sha);
      if (hit) attach(o, hit[1], hit[0]);
    }
  }

  // ---- 2) 自动配对：同项目、时间窗口内、双向都唯一
  if (windowMs > 0) {
    const byProject = new Map<string, { gits: Update[]; hosts: Update[] }>();
    const bucketOf = (pid: string) => {
      const b = byProject.get(pid) ?? { gits: [], hosts: [] };
      byProject.set(pid, b);
      return b;
    };

    for (const [sha, g] of commitsBySha) {
      if (!absorbed.has(g.id)) bucketOf(g.project_id).gits.push(g);
    }
    for (const o of others) {
      // 已被显式关联过的记录不再参与自动配对；系统审计事件也没有叙述可承载
      if (!canHost(o) || merged.has(o.id)) continue;
      bucketOf(o.project_id).hosts.push(o);
    }

    for (const { gits, hosts } of byProject.values()) {
      for (const [git, host] of pairOneToOne(gits, hosts, windowMs)) {
        attach(host, git, git.id.slice(GIT_PREFIX.length));
      }
    }
  }

  const out: MergedRecord[] = [];
  for (const e of events) {
    if (absorbed.has(e.id)) continue;
    const commits = merged.get(e.id) ?? [];
    const delta = e.delta ?? deltaFromCommit.get(e.id);
    out.push({ ...e, ...(delta !== undefined ? { delta } : {}), commits });
  }
  return out;
}

/**
 * 一对一配对：某个提交在窗口内只挨着一个汇报，且那个汇报在窗口内也只挨着这一个提交。
 * 有多对多可能时宁可放过——错并比不并更难发现。
 */
function pairOneToOne(
  gits: Update[],
  hosts: Update[],
  windowMs: number,
): Array<[Update, Update]> {
  const pairs: Array<[Update, Update]> = [];
  const freeGits = new Set(gits.map((g) => g.id));
  const freeHosts = new Set(hosts.map((h) => h.id));
  const near = (a: Update, b: Update): boolean =>
    Math.abs(Date.parse(a.ts) - Date.parse(b.ts)) <= windowMs;

  for (const g of gits) {
    if (!freeGits.has(g.id)) continue;
    const cand = hosts.filter((h) => freeHosts.has(h.id) && near(g, h));
    if (cand.length !== 1) continue;
    const host = cand[0]!;
    const back = gits.filter((x) => freeGits.has(x.id) && near(x, host));
    if (back.length !== 1) continue;

    pairs.push([g, host]);
    freeGits.delete(g.id);
    freeHosts.delete(host.id);
  }
  return pairs;
}
