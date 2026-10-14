import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { CommitChip, Empty, PriorityBadge, Skeleton, StatusBadge } from '../components/bits';
import {
  REMINDER_LEVEL_CLASS,
  SOURCE_META,
  UPDATE_TYPE_CLASS,
  UPDATE_TYPE_LABEL,
  fmtDate,
  localDay,
} from '../lib/format';
import type { Card, FeedEntry, RiskItem } from '../types';

interface Props {
  cards: Card[];
  onOpen: (id: string) => void;
}

type TypeFilter = 'all' | 'release' | 'note' | 'plan';

const TYPE_FILTERS: Array<{ key: TypeFilter; label: string; types?: string }> = [
  { key: 'all', label: '全部' },
  { key: 'release', label: '发布', types: 'release' },
  { key: 'note', label: '思考', types: 'note,status' },
  { key: 'plan', label: '计划', types: 'plan,milestone' },
];

/**
 * 跨项目动态流。
 * 回答「最近都在忙什么」——按时间倒序看所有项目的思考、发布与计划记录，
 * 而不是按时间轴看各项目的截止与里程碑。
 */
// 栅格断点放在 lg：1280 以下侧栏会被长列表挤到页面底部，等于看不见
export function Feed({ cards, onOpen }: Props) {
  const [project, setProject] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [entries, setEntries] = useState<FeedEntry[] | null>(null);
  const [reminders, setReminders] = useState<RiskItem[]>([]);

  const types = TYPE_FILTERS.find((t) => t.key === typeFilter)?.types;

  const load = useCallback(async () => {
    setEntries(null);
    try {
      const [feed, rem] = await Promise.all([
        api.feed({ limit: 120, project: project || undefined, types }),
        api.reminders(),
      ]);
      setEntries(feed);
      setReminders(rem.reminders);
    } catch {
      setEntries([]);
    }
  }, [project, types]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const map = new Map<string, FeedEntry[]>();
    for (const e of entries ?? []) {
      const day = localDay(e.ts);
      const arr = map.get(day) ?? [];
      arr.push(e);
      map.set(day, arr);
    }
    return [...map.entries()];
  }, [entries]);

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
      <section className="rounded-[var(--radius-card)] border border-line bg-surface">
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-[13px] font-semibold text-ink">动态流</h2>
          <span className="text-[11px] text-ink-mute">所有项目的思考、发布与计划记录</span>

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <div className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
              {TYPE_FILTERS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTypeFilter(t.key)}
                  className={`rounded-md px-2 py-0.5 text-[11.5px] font-medium transition-colors ${
                    typeFilter === t.key
                      ? 'bg-surface text-ink shadow-sm'
                      : 'text-ink-mute hover:text-ink-soft'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
              className="rounded-lg border border-line bg-surface px-2 py-1 text-[12px] text-ink-soft"
            >
              <option value="">全部项目</option>
              {cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </header>

        {entries === null ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : grouped.length === 0 ? (
          <Empty
            title="还没有记录"
            hint="任何实质性的想法、决策、发布都值得记一条。记录越真实，之后的回顾与每日计划越有用。"
          />
        ) : (
          <div className="flex flex-col px-4 py-3">
            {grouped.map(([day, list]) => (
              <div key={day} className="mb-1">
                <div className="sticky top-[52px] z-10 -mx-1 mb-1 flex items-center gap-2 bg-surface/90 px-1 py-1 backdrop-blur">
                  <span className="text-[11px] font-medium text-ink-mute">{fmtDate(day)}</span>
                  <span className="tnum text-[10.5px] text-ink-mute">{list.length} 条</span>
                  <span className="h-px flex-1 bg-line" />
                </div>
                <ul className="flex flex-col">
                  {list.map((e) => (
                    <li key={e.id}>
                      <button
                        onClick={() => onOpen(e.project_id)}
                        className="group flex w-full items-start gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-surface-2/60"
                      >
                        <span className="tnum mt-0.5 shrink-0 text-[10.5px] text-ink-mute">
                          {e.ts.slice(11, 16)}
                        </span>
                        <span
                          className={`mt-0.5 shrink-0 rounded px-1.5 py-px text-[10px] font-medium ${
                            UPDATE_TYPE_CLASS[e.type] ?? 'bg-surface-2 text-ink-soft'
                          }`}
                        >
                          {UPDATE_TYPE_LABEL[e.type] ?? e.type}
                        </span>
                        <span className="mt-0.5 max-w-[110px] shrink-0 truncate text-[11px] text-ink-soft">
                          {e.project_name}
                        </span>
                        {/* pre-line：记录是「结论 + 分条」的多行格式，要按行渲染 */}
                        <span className="min-w-0 flex-1 whitespace-pre-line text-[12px] leading-relaxed text-ink-soft">
                          {/* 版本与增量属于整条记录，放在结论行开头；跟在正文尾部会被误读成最后一条要点的 */}
                          {e.version && (
                            <span className="mr-1.5 font-medium text-ok">{e.version}</span>
                          )}
                          {e.delta !== undefined && e.delta !== 0 && (
                            <span
                              className={`tnum mr-1.5 font-semibold ${
                                e.delta > 0 ? 'text-ok' : 'text-danger'
                              }`}
                            >
                              {e.delta > 0 ? `+${e.delta}` : e.delta}
                            </span>
                          )}
                          {e.content}
                        </span>
                        {e.commits?.length ? (
                          <span className="mt-0.5 shrink-0">
                            <CommitChip commits={e.commits} />
                          </span>
                        ) : null}
                        <span
                          className={`mt-0.5 shrink-0 rounded px-1 py-px text-[10px] ${
                            SOURCE_META[e.source].soft
                          } ${SOURCE_META[e.source].text}`}
                          title={e.actor ? `${SOURCE_META[e.source].label} · ${e.actor}` : undefined}
                        >
                          {SOURCE_META[e.source].label}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <aside className="flex flex-col gap-3">
        <section className="rounded-[var(--radius-card)] border border-line bg-surface">
          <header className="border-b border-line px-4 py-3">
            <h2 className="text-[13px] font-semibold text-ink">计划提醒</h2>
            <p className="mt-0.5 text-[11px] text-ink-mute">有想做的事，但很久没动了</p>
          </header>
          {reminders.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-ink-mute">
              所有后续计划都在推进中
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {reminders.map((r) => (
                <li key={r.project_id}>
                  <button
                    onClick={() => onOpen(r.project_id)}
                    className="w-full px-4 py-2.5 text-left transition-colors hover:bg-surface-2/60"
                  >
                    <div className="text-[12.5px] font-medium text-ink">{r.project}</div>
                    <div className={`mt-0.5 text-[11px] ${REMINDER_LEVEL_CLASS[r.level]}`}>
                      {r.detail}
                    </div>
                    <div className="mt-0.5 text-[10.5px] text-ink-mute">{r.suggestion}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-[var(--radius-card)] border border-line bg-surface">
          <header className="border-b border-line px-4 py-3">
            <h2 className="text-[13px] font-semibold text-ink">最近无动静</h2>
            <p className="mt-0.5 text-[11px] text-ink-mute">按距上次记录时长排序</p>
          </header>
          <ul className="divide-y divide-line">
            {[...cards]
              .sort((a, b) => b.days_since_activity - a.days_since_activity)
              .slice(0, 5)
              .map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => onOpen(c.id)}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-surface-2/60"
                  >
                    <PriorityBadge priority={c.priority} />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink-soft">
                      {c.name}
                    </span>
                    <StatusBadge status={c.status} />
                    <span className="tnum shrink-0 text-[11px] text-ink-mute">
                      {c.days_since_activity} 天
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}
