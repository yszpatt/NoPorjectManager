import { useMemo, useState } from 'react';
import { Empty, StatusBadge } from '../components/bits';
import { PRIORITY_TONE, REMINDER_LEVEL_CLASS, relTime } from '../lib/format';
import type { Card } from '../types';

interface Props {
  cards: Card[];
  onOpen: (id: string) => void;
}

type SortKey = 'name' | 'status' | 'release' | 'plan' | 'idle';

const COLUMNS: Array<{ key: SortKey; label: string; align?: 'right' }> = [
  { key: 'name', label: '项目' },
  { key: 'status', label: '状态' },
  { key: 'release', label: '最近发布' },
  { key: 'plan', label: '后续计划' },
  { key: 'idle', label: '距上次记录', align: 'right' },
];

/**
 * 表格视图：列只保留「档案」关心的三件事 —— 发布、后续计划、记录活跃度。
 * 进度百分比与截止日期刻意不出现在这里。
 */
export function TableView({ cards, onOpen }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'idle', asc: true });

  const rows = useMemo(() => {
    const value = (c: Card, key: SortKey): string | number => {
      switch (key) {
        case 'name':
          return c.name;
        case 'status':
          return c.status;
        // 取负时间戳：升序即「最新发布在前」，未发布为 0 排到最后
        case 'release':
          return c.last_release ? -Date.parse(c.last_release.date) : 0;
        case 'plan':
          return c.plans[0]?.title ?? '';
        case 'idle':
          return -c.days_since_activity;
        default:
          return 0;
      }
    };
    return [...cards].sort((a, b) => {
      const va = value(a, sort.key);
      const vb = value(b, sort.key);
      const r =
        typeof va === 'number' && typeof vb === 'number'
          ? va - vb
          : String(va).localeCompare(String(vb));
      return sort.asc ? r : -r;
    });
  }, [cards, sort]);

  if (!cards.length) {
    return <Empty title="没有匹配的项目" hint="换个关键词，或先创建一个项目。" />;
  }

  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface">
      <table className="w-full min-w-[47.5rem] border-collapse text-body">
        <thead>
          <tr className="border-b border-line text-left text-meta tracking-wide text-ink-mute uppercase">
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                onClick={() => setSort((s) => ({ key: c.key, asc: s.key === c.key ? !s.asc : true }))}
                className={`cursor-pointer px-3 py-2.5 font-medium transition-colors select-none hover:text-ink ${
                  c.align === 'right' ? 'text-right' : ''
                }`}
                title="点击排序"
              >
                {c.label}
                {sort.key === c.key && <span className="ml-1">{sort.asc ? '↑' : '↓'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const rem = c.reminder;
            const plan = c.plans[0];
            return (
              <tr
                key={c.id}
                onClick={() => onOpen(c.id)}
                className="cursor-pointer border-b border-line/70 transition-colors last:border-0 hover:bg-surface-2/60"
              >
                <td className="max-w-[17.5rem] px-3 py-2">
                  <div className="flex items-center gap-2.5">
                    <span
                      className="h-7 w-[3px] shrink-0 rounded-full"
                      style={{ background: PRIORITY_TONE[c.priority] }}
                      title={`优先级 ${c.priority}`}
                    />
                    <div className="min-w-0">
                      <div className="truncate font-medium text-ink">{c.name}</div>
                      <div className="truncate text-micro text-ink-mute">
                        {rem ? (
                          <span className={REMINDER_LEVEL_CLASS[rem.level]}>{rem.detail}</span>
                        ) : (
                          c.description || c.id
                        )}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={c.status} />
                </td>
                <td className="max-w-[12rem] px-3 py-2">
                  {c.last_release ? (
                    <span className="flex items-baseline gap-1.5">
                      <span className="font-medium text-ok">{c.last_release.version}</span>
                      <span className="truncate text-meta text-ink-mute">
                        {relTime(c.last_release.date)}
                      </span>
                      {c.release_count > 1 && (
                        <span className="tnum shrink-0 text-micro text-ink-mute">
                          共 {c.release_count} 次
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-meta text-ink-mute">尚未发布</span>
                  )}
                </td>
                <td className="max-w-[13.75rem] px-3 py-2">
                  {plan ? (
                    <span className="flex items-baseline gap-1.5">
                      <span className="truncate text-ink-soft" title={plan.title}>
                        {plan.title}
                      </span>
                      {c.open_plans > 1 && (
                        <span className="shrink-0 text-micro text-ink-mute">
                          +{c.open_plans - 1}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-meta text-ink-mute">没有后续计划</span>
                  )}
                </td>
                <td className="tnum px-3 py-2 text-right">
                  <span className={c.days_since_activity > 10 ? 'text-warn' : 'text-ink-soft'}>
                    {c.days_since_activity} 天
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
