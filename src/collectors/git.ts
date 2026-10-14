import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectService } from '../core/project-service.ts';
import type { Update } from '../core/types.ts';
import { clamp, toUtcIso } from '../core/utils.ts';
import type { Store } from '../store/repo.ts';

export interface GitSyncResult {
  projects_scanned: number;
  repos_scanned: number;
  commits_seen: number;
  events_created: number;
  /** 由 tag 识别出的发布记录数 */
  releases_created: number;
  details: Array<{ project_id: string; repo: string; commits: number; created: number }>;
  warnings: string[];
}

export interface GitTag {
  tag: string;
  date: string;
  commit: string;
  subject: string;
}

export interface SyncGitOptions {
  projectId?: string;
  /** 回溯天数，默认 30；有历史事件时自动从上次同步时间起算 */
  since?: string;
  maxCommits?: number;
  actor?: string;
}

interface Commit {
  sha: string;
  date: string;
  author: string;
  subject: string;
}

/** Conventional Commits 的类型前缀。只认这些，避免把正常标题开头的词误删 */
const COMMIT_TYPES = [
  'feat',
  'fix',
  'chore',
  'docs',
  'refactor',
  'test',
  'tests',
  'build',
  'ci',
  'perf',
  'style',
  'revert',
  'wip',
];

// `!` 允许出现在 scope 前后两种位置：`feat(core)!:` 与 `feat!(core):`
const COMMIT_PREFIX_RE = new RegExp(`^(?:${COMMIT_TYPES.join('|')})(?:!?\\([^)]*\\))?!?:\\s*`, 'i');

/**
 * 把提交标题洗成人话：去掉 `feat(web):` 这类面向机器的前缀、结尾的提交者署名，
 * 以及 `[pm:id] +10` 这类已被消费掉的进度指令。
 *
 * 只做**无信息损失**的清理——不改写、不概括，那是 Agent 该做的事。
 * 署名只在它确实等于提交者时才删，避免误伤「（此前静默失效）」这种正文。
 * 原始标题保留在事件的 `refs.subject` 里，随时可回溯。
 */
export function humanizeCommitSubject(subject: string, author = '', directive?: string): string {
  const original = subject.trim();
  let s = original;

  // 指令已经变成 delta 徽章了，正文里再留一遍就是噪声
  if (directive) s = s.replace(directive, ' ');

  s = s.replace(COMMIT_PREFIX_RE, '');

  const tail = s.match(/[（(]\s*([^（()）]{1,40}?)\s*[)）]\s*$/u);
  if (tail && author) {
    const inner = tail[1].trim();
    if (inner && (inner === author || author.includes(inner) || inner.includes(author))) {
      s = s.slice(0, tail.index).trim();
    }
  }

  return s.replace(/\s+/g, ' ').trim() || original;
}

/** 采集 git commit → 事件流。git 只贡献"活跃度"，不擅自改写进度，除非 commit message 显式声明。 */
export function syncGit(
  store: Store,
  projects: ProjectService,
  opts: SyncGitOptions = {},
): GitSyncResult {
  const cfg = store.config;
  const warnings: string[] = [];
  const result: GitSyncResult = {
    projects_scanned: 0,
    repos_scanned: 0,
    commits_seen: 0,
    events_created: 0,
    releases_created: 0,
    details: [],
    warnings,
  };

  const all = projects.list({ include_archived: true });
  const targets = opts.projectId ? all.filter((p) => p.id === opts.projectId) : all.filter((p) => p.status !== 'archived');
  if (opts.projectId && !targets.length) {
    warnings.push(`项目不存在：${opts.projectId}`);
  }

  const recordPattern = safeRegex(cfg.git.messagePattern);

  for (const project of targets) {
    result.projects_scanned += 1;
    if (!project.repos?.length) continue;
    const detail = { project_id: project.id, repo: '', commits: 0, created: 0 };

    for (const repo of project.repos) {
      const repoPath = repo.path;
      if (!repoPath) {
        warnings.push(`项目 ${project.id} 的仓库 ${repo.url ?? ''} 是远程地址，本地同步暂不支持`);
        continue;
      }
      if (!isGitRepo(repoPath)) {
        warnings.push(`不是有效的 git 仓库：${repoPath}`);
        continue;
      }

      result.repos_scanned += 1;
      // 事件 id 由 commit 全量 sha 派生（git-<sha>），据此去重才能保证多次同步幂等
      const existing = new Set(
        store
          .eventsFromIndex(project.id, 2000)
          .filter((e) => e.source === 'git')
          .map((e) => e.id),
      );

      const lastGitTs = store
        .eventsFromIndex(project.id, 2000)
        .filter((e) => e.source === 'git')
        .map((e) => e.ts)
        .sort()
        .at(-1);
      const since = opts.since ?? lastGitTs ?? new Date(Date.now() - 30 * 86400_000).toISOString();

      let commits: Commit[] = [];
      try {
        commits = listCommits(repoPath, since, opts.maxCommits ?? 200, repo.branch);
      } catch (e) {
        warnings.push(`读取 ${repoPath} 提交失败：${(e as Error).message}`);
        continue;
      }

      result.commits_seen += commits.length;
      for (const c of commits) {
        if (existing.has(`git-${c.sha}`)) continue;
        const parsed = recordPattern ? matchRecord(recordPattern, c.subject) : null;
        if (parsed && parsed.id !== project.id) {
          // 该提交通过 [pm:xxx] 声明归属其它项目，交由对应项目同步
          continue;
        }

        const update: Update = {
          id: `git-${c.sha}`,
          project_id: project.id,
          // git %aI 带本地偏移，统一转成 UTC，避免与其它事件混排时顺序错乱
          ts: toUtcIso(c.date),
          source: 'git',
          type: parsed ? 'progress' : 'note',
          // 提交标题原样倾倒会让看板变成 git log。署名不再拼进正文（actor 里已有）
          content: humanizeCommitSubject(c.subject, c.author, parsed?.text),
          delta: parsed?.delta,
          // 提交者是事实，调用方传入的 actor 只是兜底（作者信息缺失时）
          actor: c.author || opts.actor,
          refs: { commit: c.sha.slice(0, 12), repo: repoPath, subject: c.subject },
        };
        store.appendEvent(update);
        detail.commits += 1;
        detail.created += 1;
        result.events_created += 1;

        if (parsed?.delta) {
          const project_ = projects.get(project.id, { timeline: false });
          if (project_) {
            const next = clamp(project_.progress + parsed.delta, 0, 100);
            // 这次进度变更是这条提交引起的：把提交 sha 挂上，
            // 读取时它会并回提交那一条，避免同一次提交在看板上留下两行
            projects.update(project.id, {
              progress: next,
              source: 'git',
              actor: `git:${c.author}`,
              refs: { commit: c.sha.slice(0, 12), repo: repoPath },
            });
          }
        }
      }

      // ---- 发布记录：命名符合版本规范的 tag 视为一次发布 ----
      const tagPattern = safeRegex(cfg.git.releaseTagPattern);
      if (tagPattern) {
        const existingReleases = new Set(
          store
            .eventsFromIndex(project.id, 2000)
            .filter((e) => e.type === 'release')
            .map((e) => e.id),
        );
        let tags: GitTag[] = [];
        try {
          tags = listTags(repoPath);
        } catch (e) {
          warnings.push(`读取 ${repoPath} 的 tag 失败：${(e as Error).message}`);
        }
        for (const t of tags) {
          if (!tagPattern.test(t.tag)) continue;
          const eventId = `release-${t.tag}`;
          if (existingReleases.has(eventId)) continue;
          store.appendEvent({
            id: eventId,
            project_id: project.id,
            ts: toUtcIso(t.date),
            source: 'git',
            type: 'release',
            content: humanizeCommitSubject(t.subject) || `发布 ${t.tag}`,
            version: t.tag,
            actor: opts.actor ?? 'git',
            refs: { tag: t.tag, commit: t.commit.slice(0, 12), repo: repoPath },
          });
          result.releases_created += 1;
        }
      }

      result.details.push({ ...detail, repo: repoPath });
    }
  }

  return result;
}

export function isGitRepo(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

export function listCommits(
  dir: string,
  sinceIso: string,
  max: number,
  branch?: string,
): Commit[] {
  const sep = '\u001f';
  const args = [
    '-C',
    dir,
    'log',
    branch || 'HEAD',
    `--since=${sinceIso}`,
    `-n`,
    String(max),
    `--pretty=format:%H${sep}%aI${sep}%an${sep}%s`,
  ];
  const raw = execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  const out: Commit[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [sha, date, author, ...rest] = line.split(sep);
    if (!sha || !date) continue;
    out.push({ sha, date, author: author ?? '', subject: rest.join(sep) });
  }
  return out;
}

/**
 * 读取仓库的所有 tag。
 * 用 for-each-ref 一次取全，避免逐个 tag 调 git show。
 * creatordate 对附注 tag 是打 tag 的时间，对轻量 tag 是提交时间，两者都符合"何时发布"的语义。
 */
export function listTags(dir: string): GitTag[] {
  const sep = '\u001f';
  const raw = execFileSync(
    'git',
    [
      '-C',
      dir,
      'for-each-ref',
      '--sort=-creatordate',
      `--format=%(refname:short)${sep}%(creatordate:iso-strict)${sep}%(objectname)${sep}%(contents:subject)`,
      'refs/tags',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 },
  );
  const out: GitTag[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [tag, date, commit, ...rest] = line.split(sep);
    if (!tag || !date) continue;
    out.push({ tag, date, commit: commit ?? '', subject: rest.join(sep).trim() });
  }
  return out;
}

/** 在给定根目录下发现 git 仓库（默认深度 2） */
export function discoverRepos(root: string, depth = 2): string[] {
  const found: string[] = [];
  const walk = (dir: string, level: number): void => {
    if (level > depth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isDirectory() && e.name === '.git')) {
      found.push(dir);
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      walk(path.join(dir, e.name), level + 1);
    }
  };
  walk(root, 0);
  return found;
}

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function matchRecord(
  re: RegExp,
  subject: string,
): { id: string; delta?: number; text: string } | null {
  const m = re.exec(subject);
  if (!m) return null;
  const id = m.groups?.id ?? m[1];
  if (!id) return null;
  const deltaRaw = m.groups?.delta ?? m[2];
  const delta = deltaRaw ? Number(deltaRaw) : undefined;
  return {
    id,
    delta: Number.isFinite(delta as number) ? (delta as number) : undefined,
    text: m[0],
  };
}
