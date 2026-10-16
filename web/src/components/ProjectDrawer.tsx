import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Notice } from '../App';
import { Markdown } from './Markdown';
import {
  Btn,
  Collapsible,
  CommitChip,
  Drawer,
  Field,
  HealthBadge,
  Input,
  Menu,
  PriorityBadge,
  ProgressRing,
  Select,
  Skeleton,
  SourceBadge,
  Sparkline,
  StatusBadge,
  Switch,
  TextArea,
} from './bits';
import {
  HEALTH_TONE,
  REMINDER_LEVEL_CLASS,
  ROADMAP_STATUS_LABEL,
  daysLabel,
  fmtDate,
  relTime,
} from '../lib/format';
import type { Goal, ProjectDetail, RoadmapItem, Status } from '../types';

interface Props {
  projectId: string | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
  notify: (n: Notice) => void;
}

const STATUS_OPTIONS = [
  { value: 'idea', label: '想法' },
  { value: 'planning', label: '规划中' },
  { value: 'active', label: '进行中' },
  { value: 'blocked', label: '阻塞' },
  { value: 'paused', label: '已暂停' },
  { value: 'done', label: '已完成' },
];

const ROADMAP_CYCLE: RoadmapItem['status'][] = ['planned', 'in_progress', 'done', 'dropped'];
const RECENT_EVENTS = 6;

/**
 * 项目详情。抽屉首屏只放「进度、截止、未来规划、时间线」四件事，
 * 目标/仓库/介绍收进折叠区，避免一屏塞满需要维护的字段。
 */
export function ProjectDrawer({ projectId, onClose, onChanged, notify }: Props) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [autoProgress, setAutoProgress] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<'progress' | 'edit' | 'release' | null>(null);
  const [showAllEvents, setShowAllEvents] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [d, cfg] = await Promise.all([api.project(projectId), api.config()]);
      setDetail(d);
      setAutoProgress(cfg.config.progress?.mode === 'auto');
    } catch (e) {
      notify({ kind: 'err', text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [projectId, notify]);

  useEffect(() => {
    setPanel(null);
    setShowAllEvents(false);
    void load();
  }, [load]);

  const mutate = async (fn: () => Promise<unknown>, okText?: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
      await onChanged();
      if (okText) notify({ kind: 'ok', text: okText });
    } catch (e) {
      notify({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  /** 由带进度的记录还原趋势；少于 2 个点不画，避免误导性的直线 */
  const trend = useMemo(() => {
    if (!detail) return [];
    const withDelta = [...detail.timeline]
      .reverse()
      .filter((e) => typeof e.delta === 'number' && e.delta !== 0);
    if (withDelta.length < 2) return [];
    let base = detail.progress - withDelta.reduce((s, e) => s + (e.delta ?? 0), 0);
    return withDelta.map((e) => (base += e.delta ?? 0));
  }, [detail]);

  const events = useMemo(() => {
    if (!detail) return [];
    return showAllEvents ? detail.timeline : detail.timeline.slice(0, RECENT_EVENTS);
  }, [detail, showAllEvents]);

  return (
    <Drawer open={Boolean(projectId)} onClose={onClose} width={40}>
      {loading && !detail ? (
        <div className="flex flex-col gap-3 p-5">
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-20" />
          <Skeleton className="h-32" />
        </div>
      ) : !detail ? (
        <div className="p-8 text-center text-lead text-ink-mute">项目不存在或已被删除</div>
      ) : (
        <div className="flex flex-col">
          {/* 头部：标题 + 两个动作，其余进菜单 */}
          <header className="sticky top-0 z-10 border-b border-line bg-surface/92 px-5 py-3.5 backdrop-blur">
            <div className="flex items-center gap-2">
              <PriorityBadge priority={detail.priority} />
              <h2 className="min-w-0 flex-1 truncate text-title font-semibold tracking-tight text-ink">
                {detail.name}
              </h2>
              <Btn size="sm" variant="primary" disabled={busy} onClick={() => setPanel(panel === 'progress' ? null : 'progress')}>
                记录进展
              </Btn>
              <Btn
                size="sm"
                disabled={busy}
                title="留档一次版本发布"
                onClick={() => setPanel(panel === 'release' ? null : 'release')}
              >
                记录发布
              </Btn>
              <Menu
                title="更多操作"
                items={[
                  { label: '编辑项目', onClick: () => setPanel(panel === 'edit' ? null : 'edit') },
                  {
                    label: '同步 Git 提交',
                    onClick: () =>
                      void mutate(async () => {
                        const r = await api.syncGit(detail.id);
                        notify({
                          kind: 'ok',
                          text: r.events_created > 0 ? `采集到 ${r.events_created} 条提交` : '没有新的提交',
                        });
                      }),
                  },
                  {
                    label: '归档项目',
                    danger: true,
                    onClick: () =>
                      void mutate(async () => {
                        await api.deleteProject(detail.id);
                        onClose();
                      }, '项目已归档'),
                  },
                ]}
              />
              <button
                onClick={onClose}
                className="grid size-7 place-items-center rounded-lg text-ink-mute transition-colors hover:text-ink"
                aria-label="关闭"
              >
                ✕
              </button>
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ink-mute">
              <code className="rounded bg-surface-2 px-1.5 py-0.5">{detail.id}</code>
              <StatusBadge status={detail.status} />
              {(detail.health === 'at_risk' || detail.health === 'stale' || detail.health === 'unknown') && (
                <HealthBadge health={detail.health} reason={detail.health_reason} />
              )}
              <span>·</span>
              <span>更新于 {relTime(detail.updated_at)}</span>
              {detail.progress_derived && (
                <>
                  <span>·</span>
                  <span className="rounded bg-accent/10 px-1.5 py-0.5 text-accent">进度自动跟随里程碑</span>
                </>
              )}
            </div>

            {/* 计划停滞提醒：这是唯一会主动打断你的信号 */}
            {detail.reminder && (
              <div
                className={`mt-2 rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-meta leading-relaxed ${
                  REMINDER_LEVEL_CLASS[detail.reminder.level]
                }`}
              >
                <div className="font-medium">{detail.reminder.detail}</div>
                <div className="mt-0.5 text-ink-mute">{detail.reminder.suggestion}</div>
              </div>
            )}

            {panel === 'progress' && (
              <ProgressForm
                busy={busy}
                onSubmit={(v) =>
                  void mutate(() => api.reportProgress(detail.id, v), '已记录进展').then(() =>
                    setPanel(null),
                  )
                }
              />
            )}
            {panel === 'edit' && (
              <EditForm
                detail={detail}
                busy={busy}
                onCancel={() => setPanel(null)}
                onSubmit={(v) =>
                  void mutate(() => api.updateProject(detail.id, v), '已更新').then(() => setPanel(null))
                }
              />
            )}
            {panel === 'release' && (
              <ReleaseForm
                busy={busy}
                onCancel={() => setPanel(null)}
                onSubmit={(v) =>
                  void mutate(() => api.reportRelease(detail.id, v), '已记录发布').then(() =>
                    setPanel(null),
                  )
                }
              />
            )}
          </header>

          {/* 概览：只留进度与截止 */}
          <section className="border-b border-line px-5 py-4">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <div className="flex items-center gap-3">
                <ProgressRing
                  value={detail.progress}
                  size={52}
                  stroke={5}
                  tone={HEALTH_TONE[detail.health]}
                />
                <div>
                  <div className="text-meta text-ink-mute">进度</div>
                  <div className="tnum text-title font-semibold text-ink">{detail.progress}%</div>
                </div>
              </div>

              <div>
                <div className="text-meta text-ink-mute">截止</div>
                <div
                  className={`tnum text-title font-semibold ${
                    detail.days_to_target !== null && detail.days_to_target < 0
                      ? 'text-danger'
                      : 'text-ink'
                  }`}
                >
                  {detail.target_date ? fmtDate(detail.target_date) : '未设'}
                </div>
                {detail.target_date && (
                  <div className="text-micro text-ink-mute">{daysLabel(detail.days_to_target)}</div>
                )}
              </div>

              <div className="ml-auto">
                <Switch
                  checked={autoProgress === true}
                  onChange={(v) =>
                    void mutate(
                      () => api.updateConfig({ progress: { mode: v ? 'auto' : 'declared' } }),
                      v ? '进度改为自动跟随里程碑' : '进度改回人工维护',
                    )
                  }
                  label="进度自动跟随里程碑"
                  title="开启后只需切换里程碑状态，进度自动计算（全局设置）"
                />
              </div>
            </div>

            {detail.health_reason && (
              <p className="mt-3 text-meta leading-relaxed text-ink-mute">
                {detail.health_reason}
              </p>
            )}

            {trend.length >= 2 && (
              <div className="mt-3">
                <Sparkline points={trend} width={260} height={30} tone="var(--color-accent)" />
              </div>
            )}

            <p className="mt-3 text-micro text-ink-mute">
              活跃度 {detail.momentum.toFixed(1)} · 最近活动 {detail.days_since_activity} 天前 ·{' '}
              {detail.event_count} 条记录
            </p>
          </section>

          {/* 发布记录：独立开发里最值得留档的东西 */}
          <section className="border-b border-line px-5 py-4">
            <div className="mb-2.5 flex flex-wrap items-center gap-2">
              <h3 className="text-body font-semibold text-ink">发布记录</h3>
              <span className="tnum text-meta text-ink-mute">{detail.releases.length}</span>
              {detail.last_release && (
                <span className="text-micro text-ink-mute">
                  · 最近 {detail.last_release.version}（{relTime(detail.last_release.date)}）
                </span>
              )}
            </div>
            {detail.releases.length === 0 ? (
              <p className="text-body leading-relaxed text-ink-mute">
                还没有发布记录。点「记录发布」留档第一个版本；关联仓库并打了版本 tag 后，同步 Git 会
                自动把 tag 采集为发布。
              </p>
            ) : (
              <ul className="flex flex-col">
                {detail.releases.map((r) => (
                  <li key={`${r.version}-${r.date}`} className="flex items-start gap-2.5 py-1.5">
                    <span className="mt-0.5 shrink-0 rounded bg-ok/12 px-1.5 py-0.5 text-micro font-medium text-ok">
                      {r.version}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-body leading-relaxed text-ink-soft">
                        {r.note ?? '（无说明）'}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-micro text-ink-mute">
                        <span>{fmtDate(r.date)}</span>
                        {r.tag && (
                          <code className="rounded bg-surface-2 px-1 py-px font-mono">{r.tag}</code>
                        )}
                        {r.url && (
                          <a
                            href={r.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-accent hover:underline"
                          >
                            发布页
                          </a>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 未来规划：每日计划的输入源，默认展开 */}
          <section className="border-b border-line px-5 py-4">
            <div className="mb-2.5 flex items-center gap-2">
              <h3 className="text-body font-semibold text-ink">未来规划</h3>
              <span className="tnum text-meta text-ink-mute">{detail.roadmap.length}</span>
              <span className="truncate text-micro text-ink-mute">· 每日计划由最近的里程碑推导</span>
            </div>
            <RoadmapEditor
              items={detail.roadmap}
              busy={busy}
              onUpsert={(patch) => void mutate(() => api.upsertRoadmap(detail.id, patch))}
              onRemove={(id) => void mutate(() => api.removeRoadmap(detail.id, id), '已删除里程碑')}
            />
          </section>

          {/* 以下三块默认收起 */}
          <Collapsible title="目标" count={detail.goals.length} hint="可量化指标">
            <GoalEditor
              goals={detail.goals}
              busy={busy}
              onUpsert={(patch) => void mutate(() => api.upsertGoal(detail.id, patch))}
              onRemove={(id) => void mutate(() => api.removeGoal(detail.id, id), '目标已删除')}
            />
          </Collapsible>

          <Collapsible title="关联仓库" count={detail.repos.length} hint="自动采集 commit">
            <RepoEditor
              repos={detail.repos}
              busy={busy}
              onLink={(repo) => void mutate(() => api.linkRepo(detail.id, repo), '已关联仓库')}
              onUnlink={(key) =>
                void mutate(() => api.linkRepo(detail.id, { path: key, unlink: true }), '已解绑')
              }
            />
          </Collapsible>

          {detail.body?.trim() && (
            <Collapsible title="介绍">
              <div className="px-5">
                <Markdown text={detail.body} />
              </div>
            </Collapsible>
          )}

          {/* 时间线：默认只看最近几条 */}
          <section className="px-5 py-4">
            <div className="mb-2.5 flex items-center gap-2">
              <h3 className="text-body font-semibold text-ink">进展记录</h3>
              <span className="tnum text-meta text-ink-mute">{detail.event_count}</span>
            </div>

            {detail.timeline.length === 0 ? (
              <p className="text-body text-ink-mute">还没有记录。点「记录进展」写下第一条。</p>
            ) : (
              <>
                <ul className="flex flex-col gap-1.5">
                  {events.map((e) => (
                    <li key={e.ts + e.content} className="rounded-lg border border-line bg-surface px-3 py-2">
                      <div className="flex items-center gap-2">
                        <SourceBadge source={e.source} />
                        <CommitChip commits={e.commits} />
                        {e.delta !== undefined && e.delta !== 0 && (
                          <span
                            className={`tnum text-micro font-semibold ${
                              e.delta > 0 ? 'text-ok' : 'text-danger'
                            }`}
                          >
                            {e.delta > 0 ? `+${e.delta}` : e.delta}
                          </span>
                        )}
                        <span className="ml-auto text-micro text-ink-mute">{relTime(e.ts)}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-line text-body leading-relaxed text-ink-soft">
                        {e.content}
                      </p>
                      {(e.actor || e.refs) && (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-micro text-ink-mute">
                          {e.actor && <span>{e.actor}</span>}
                          {e.refs &&
                            Object.entries(e.refs).map(([k, v]) => (
                              <span key={k} className="rounded bg-surface-2 px-1 py-px font-mono">
                                {k}:{String(v)}
                              </span>
                            ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                {detail.timeline.length > RECENT_EVENTS && (
                  <button
                    onClick={() => setShowAllEvents(!showAllEvents)}
                    className="mt-2 text-meta text-ink-mute transition-colors hover:text-accent"
                  >
                    {showAllEvents ? '收起' : `展开全部 ${detail.timeline.length} 条`}
                  </button>
                )}
              </>
            )}
          </section>

          <footer className="border-t border-line px-5 py-3 text-micro text-ink-mute">
            事实源：<code>.projectmanager/projects/{detail.id}.md</code>
          </footer>
        </div>
      )}
    </Drawer>
  );
}

/* ------------------------------------------------------------------ 规划 */

function RoadmapEditor({
  items,
  busy,
  onUpsert,
  onRemove,
}: {
  items: RoadmapItem[];
  busy: boolean;
  onUpsert: (patch: Record<string, unknown>) => void;
  onRemove: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');

  const add = () => {
    if (!title.trim()) return;
    onUpsert({ title: title.trim(), due: due || undefined, status: 'planned' });
    setTitle('');
    setDue('');
    setOpen(false);
  };

  return (
    <div className="flex flex-col">
      {items.length === 0 ? (
        <p className="text-body leading-relaxed text-ink-mute">
          还没有里程碑。没有未来规划时，每日计划只能给出空泛的建议。
        </p>
      ) : (
        <ul className="flex flex-col">
          {items.map((r) => {
            const days = r.due ? daysUntil(r.due) : null;
            const overdue = days !== null && days < 0 && r.status !== 'done' && r.status !== 'dropped';
            return (
              <li key={r.id} className="group flex items-center gap-2 py-1.5">
                <button
                  disabled={busy}
                  onClick={() =>
                    onUpsert({
                      id: r.id,
                      title: r.title,
                      due: r.due,
                      status: ROADMAP_CYCLE[(ROADMAP_CYCLE.indexOf(r.status) + 1) % ROADMAP_CYCLE.length],
                    })
                  }
                  className={`shrink-0 rounded px-1.5 py-0.5 text-micro font-medium transition-colors ${
                    r.status === 'done'
                      ? 'bg-ok/12 text-ok'
                      : r.status === 'in_progress'
                        ? 'bg-accent/12 text-accent'
                        : r.status === 'dropped'
                          ? 'bg-surface-2 text-ink-mute line-through'
                          : 'bg-surface-2 text-ink-soft'
                  }`}
                  title="点击切换状态"
                >
                  {ROADMAP_STATUS_LABEL[r.status]}
                </button>
                <span
                  className={`min-w-0 flex-1 truncate text-body ${
                    r.status === 'done' || r.status === 'dropped'
                      ? 'text-ink-mute line-through'
                      : 'text-ink'
                  }`}
                >
                  {r.title}
                </span>
                {/* 已完成/已放弃的项不再显示倒计时 —— 它已经没有行动含义 */}
                {r.due && r.status !== 'done' && r.status !== 'dropped' && (
                  <span className={`tnum shrink-0 text-micro ${overdue ? 'text-danger' : 'text-ink-mute'}`}>
                    {daysLabel(days)}
                  </span>
                )}
                <button
                  disabled={busy}
                  onClick={() => onRemove(r.id)}
                  className="shrink-0 text-meta text-ink-mute opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger"
                  title="删除"
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {open ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input value={title} onChange={setTitle} placeholder="里程碑名称" className="min-w-[150px] flex-1" />
          <Input value={due} onChange={setDue} type="date" className="w-[140px]" />
          <Btn size="sm" variant="primary" disabled={busy || !title.trim()} onClick={add}>
            添加
          </Btn>
          <Btn size="sm" onClick={() => setOpen(false)}>
            取消
          </Btn>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="mt-1.5 self-start text-meta text-ink-mute transition-colors hover:text-accent"
        >
          + 添加里程碑
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 目标 */

function GoalEditor({
  goals,
  busy,
  onUpsert,
  onRemove,
}: {
  goals: Goal[];
  busy: boolean;
  onUpsert: (patch: Record<string, unknown>) => void;
  onRemove: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [metric, setMetric] = useState('');
  const [target, setTarget] = useState('');
  const [due, setDue] = useState('');

  const add = () => {
    if (!title.trim()) return;
    onUpsert({
      title: title.trim(),
      metric: metric.trim() || undefined,
      target: target ? Number(target) : undefined,
      current: target ? 0 : undefined,
      due: due || undefined,
      status: 'open',
    });
    setTitle('');
    setMetric('');
    setTarget('');
    setDue('');
    setOpen(false);
  };

  return (
    <div className="flex flex-col px-5">
      {goals.length > 0 && (
        <ul className="flex flex-col divide-y divide-line">
          {goals.map((g) => (
            <GoalRow
              key={g.id}
              goal={g}
              busy={busy}
              onSave={(patch) => onUpsert({ id: g.id, title: g.title, ...patch })}
              onRemove={() => onRemove(g.id)}
            />
          ))}
        </ul>
      )}

      {open ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input value={title} onChange={setTitle} placeholder="目标名称" className="min-w-[130px] flex-1" />
          <Input value={metric} onChange={setMetric} placeholder="指标" className="w-[70px]" />
          <Input value={target} onChange={setTarget} type="number" placeholder="目标值" className="w-[76px]" />
          <Input value={due} onChange={setDue} type="date" className="w-[136px]" />
          <Btn size="sm" variant="primary" disabled={busy || !title.trim()} onClick={add}>
            添加
          </Btn>
          <Btn size="sm" onClick={() => setOpen(false)}>
            取消
          </Btn>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="mt-2 self-start text-meta text-ink-mute transition-colors hover:text-accent"
        >
          + 添加目标
        </button>
      )}
    </div>
  );
}

function GoalRow({
  goal,
  busy,
  onSave,
  onRemove,
}: {
  goal: Goal;
  busy: boolean;
  onSave: (patch: Partial<Goal>) => void;
  onRemove: () => void;
}) {
  const hasMetric = goal.target !== undefined && goal.target !== null;
  const pct = hasMetric ? Math.min(100, Math.round(((goal.current ?? 0) / goal.target!) * 100)) : 0;
  return (
    <li className="group py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body text-ink">{goal.title}</span>
        {hasMetric && (
          <span className="tnum text-meta text-ink-soft">
            {goal.current ?? 0}/{goal.target} {goal.metric ?? ''}
          </span>
        )}
        <button
          onClick={onRemove}
          disabled={busy}
          className="text-meta text-ink-mute opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger"
          title="删除目标"
        >
          ✕
        </button>
      </div>
      {hasMetric && (
        <div className="mt-1.5 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-accent/70" style={{ width: `${pct}%` }} />
          </div>
          {[1, 5].map((d) => (
            <button
              key={d}
              disabled={busy}
              onClick={() => onSave({ current: Math.min(goal.target!, (goal.current ?? 0) + d) })}
              className="rounded border border-line px-1.5 py-px text-micro text-ink-mute transition-colors hover:border-accent hover:text-accent"
            >
              +{d}
            </button>
          ))}
          {goal.status !== 'done' && (
            <button
              disabled={busy}
              onClick={() => onSave({ status: 'done', current: goal.target })}
              className="rounded border border-line px-1.5 py-px text-micro text-ink-mute transition-colors hover:border-ok hover:text-ok"
            >
              达成
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ 仓库 */

function RepoEditor({
  repos,
  busy,
  onLink,
  onUnlink,
}: {
  repos: ProjectDetail['repos'];
  busy: boolean;
  onLink: (repo: { path?: string; url?: string; branch?: string }) => void;
  onUnlink: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  return (
    <div className="flex flex-col gap-1.5 px-5">
      {repos.length === 0 && !open && (
        <p className="text-body text-ink-mute">尚未关联仓库，Git 提交不会被采集。</p>
      )}
      {repos.map((r) => {
        const key = r.path ?? r.url ?? '';
        return (
          <div key={key} className="group flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5">
            <code className="min-w-0 flex-1 truncate font-mono text-meta text-ink-soft">{key}</code>
            <button
              disabled={busy}
              onClick={() => onUnlink(key)}
              className="text-meta text-ink-mute opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger"
            >
              ✕
            </button>
          </div>
        );
      })}
      {open ? (
        <div className="mt-1 flex items-center gap-2">
          <Input value={path} onChange={setPath} placeholder="本地仓库绝对路径" className="flex-1" />
          <Btn
            size="sm"
            variant="primary"
            disabled={busy || !path.trim()}
            onClick={() => {
              onLink({ path: path.trim() });
              setPath('');
              setOpen(false);
            }}
          >
            关联
          </Btn>
          <Btn size="sm" onClick={() => setOpen(false)}>
            取消
          </Btn>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="mt-1 self-start text-meta text-ink-mute transition-colors hover:text-accent"
        >
          + 关联仓库
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 表单 */

function ReleaseForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (v: { version: string; note?: string; url?: string; tag?: string }) => void;
}) {
  const [version, setVersion] = useState('');
  const [note, setNote] = useState('');
  const [url, setUrl] = useState('');
  const [tag, setTag] = useState('');
  return (
    <div className="mt-3 flex flex-col gap-2 rounded-lg border border-line bg-surface-2/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={version}
          onChange={setVersion}
          placeholder="版本号，如 v0.3.2"
          className="w-[150px]"
        />
        <Input
          value={tag}
          onChange={setTag}
          placeholder="git tag（可选）"
          className="w-[130px]"
        />
        <Input
          value={url}
          onChange={setUrl}
          placeholder="发布页链接（可选）"
          className="min-w-[150px] flex-1"
        />
      </div>
      <TextArea
        value={note}
        onChange={setNote}
        rows={2}
        placeholder="这次发布包含什么？一句话即可。"
      />
      <div className="flex items-center gap-2">
        <Btn
          size="sm"
          variant="primary"
          disabled={busy || !version.trim()}
          onClick={() =>
            onSubmit({
              version: version.trim(),
              note: note.trim() || undefined,
              url: url.trim() || undefined,
              tag: tag.trim() || undefined,
            })
          }
        >
          提交
        </Btn>
        <Btn size="sm" onClick={onCancel}>
          取消
        </Btn>
      </div>
    </div>
  );
}

function ProgressForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (v: { content: string; delta?: number; type?: string }) => void;
}) {
  const [content, setContent] = useState('');
  const [delta, setDelta] = useState('5');
  const [withDelta, setWithDelta] = useState(true);
  return (
    <div className="mt-3 flex flex-col gap-2 rounded-lg border border-line bg-surface-2/60 p-3">
      <TextArea
        value={content}
        onChange={setContent}
        placeholder="写结论，不写流水账。例如：双写灰度切流 30%，P99 从 480ms 降到 210ms"
        rows={2}
      />
      <div className="flex flex-wrap items-center gap-2.5">
        <Switch checked={withDelta} onChange={setWithDelta} label="同时更新进度" />
        {withDelta && (
          <input
            type="number"
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            className="tnum w-16 rounded-md border border-line bg-surface px-2 py-1 text-body text-ink"
          />
        )}
        <Btn
          size="sm"
          variant="primary"
          disabled={busy || !content.trim()}
          onClick={() =>
            onSubmit({
              content: content.trim(),
              delta: withDelta ? Number(delta) || 0 : undefined,
            })
          }
        >
          提交
        </Btn>
      </div>
    </div>
  );
}

function EditForm({
  detail,
  busy,
  onCancel,
  onSubmit,
}: {
  detail: ProjectDetail;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (v: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(detail.name);
  const [description, setDescription] = useState(detail.description);
  const [status, setStatus] = useState<Status>(detail.status);
  const [priority, setPriority] = useState(detail.priority);
  const [progress, setProgress] = useState(String(detail.progress));
  const [target, setTarget] = useState(detail.target_date ?? '');
  const [tags, setTags] = useState(detail.tags.join(', '));

  return (
    <div className="mt-3 flex flex-col gap-2.5 rounded-lg border border-line bg-surface-2/60 p-3">
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <Field label="名称">
          <Input value={name} onChange={setName} />
        </Field>
        <Field label="在做什么">
          <Input value={description} onChange={setDescription} />
        </Field>
        <Field label="状态">
          <Select value={status} onChange={(v) => setStatus(v as Status)} options={STATUS_OPTIONS} />
        </Field>
        <Field label="优先级">
          <Select
            value={priority}
            onChange={(v) => setPriority(v as ProjectDetail['priority'])}
            options={['P0', 'P1', 'P2', 'P3'].map((p) => ({ value: p, label: p }))}
          />
        </Field>
        <Field label={`进度（当前 ${detail.progress}%）`}>
          <Input value={progress} onChange={setProgress} type="number" />
        </Field>
        <Field label="截止日期">
          <Input value={target} onChange={setTarget} type="date" />
        </Field>
        <Field label="标签（逗号分隔）">
          <Input value={tags} onChange={setTags} />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Btn
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() =>
            onSubmit({
              name: name.trim(),
              description,
              status,
              priority,
              progress: Number(progress) || 0,
              target_date: target || null,
              tags: tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
            })
          }
        >
          保存
        </Btn>
        <Btn size="sm" onClick={onCancel}>
          取消
        </Btn>
      </div>
    </div>
  );
}

function daysUntil(date: string): number {
  const d = new Date(`${date}T00:00:00`).getTime();
  const today = new Date().setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}
