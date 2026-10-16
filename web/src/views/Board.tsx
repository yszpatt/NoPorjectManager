import { useState } from 'react';
import { api } from '../api';
import { Empty } from '../components/bits';
import type { Notice } from '../App';
import {
  BOARD_COLUMNS,
  PRIORITY_TONE,
  REMINDER_LEVEL_CLASS,
  SOURCE_META,
  STATUS_META,
  relTime,
  reminderRank,
} from '../lib/format';
import type { Card, Status } from '../types';

interface Props {
  cards: Card[];
  onOpen: (id: string) => void;
  onChanged: () => Promise<void>;
  notify: (n: Notice) => void;
}

/**
 * 看板视图。
 *
 * 卡片按「项目档案」的关注点排列：
 *   ① 名称 + 状态
 *   ② 提醒（仅计划停滞时出现）
 *   ③ 未来规划（最多 3 条未完成项）
 *   ④ 最近记录（最多 3 条）
 * 发布情况、进度百分比与截止日期都不在卡片上——它们在表格视图与详情页。
 */
export function Board({ cards, onOpen, onChanged, notify }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [hoverCol, setHoverCol] = useState<Status | null>(null);

  const byStatus = new Map<Status, Card[]>();
  for (const c of cards) {
    const bucket = byStatus.get(c.status) ?? [];
    bucket.push(c);
    byStatus.set(c.status, bucket);
  }

  // 有提醒的排前面，其次优先级，最后按最近有动静的排
  const order = (list: Card[]): Card[] =>
    [...list].sort(
      (a, b) =>
        reminderRank(b.reminder) - reminderRank(a.reminder) ||
        a.priority.localeCompare(b.priority) ||
        b.updated_at.localeCompare(a.updated_at),
    );

  const columns = BOARD_COLUMNS.filter((s) => (byStatus.get(s) ?? []).length > 0);

  const move = async (id: string, status: Status) => {
    const card = cards.find((c) => c.id === id);
    if (!card || card.status === status) return;
    try {
      await api.updateProject(id, { status });
      await onChanged();
      notify({ kind: 'ok', text: `「${card.name}」已移至「${STATUS_META[status].label}」` });
    } catch (e) {
      notify({ kind: 'err', text: (e as Error).message });
    }
  };

  if (!cards.length) {
    return <Empty title="没有匹配的项目" hint="换个关键词，或点右上角「+ 新建」登记第一个项目。" />;
  }

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {columns.map((status) => {
        const list = order(byStatus.get(status) ?? []);
        const meta = STATUS_META[status];
        const isHover = hoverCol === status;
        return (
          <div
            key={status}
            className="flex w-[18rem] shrink-0 flex-col"
            onDragOver={(e) => {
              e.preventDefault();
              setHoverCol(status);
            }}
            onDragLeave={() => setHoverCol((c) => (c === status ? null : c))}
            onDrop={(e) => {
              e.preventDefault();
              setHoverCol(null);
              if (dragId) void move(dragId, status);
              setDragId(null);
            }}
          >
            <header className="mb-2 flex items-center gap-2 px-0.5">
              <span className={`size-1.5 rounded-full ${meta.bg}`} />
              <h2 className="text-body font-medium text-ink-soft">{meta.label}</h2>
              <span className="tnum text-meta text-ink-mute">{list.length}</span>
            </header>

            <div
              className={`flex min-h-[120px] flex-1 flex-col gap-2 rounded-xl border border-dashed p-1.5 transition-colors ${
                isHover ? 'border-accent/50 bg-accent/5' : 'border-line/60 bg-surface-2/30'
              }`}
            >
              {list.map((c) => (
                <ProjectCard
                  key={c.id}
                  card={c}
                  dragging={dragId === c.id}
                  onDragStart={() => setDragId(c.id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setHoverCol(null);
                  }}
                  onOpen={() => onOpen(c.id)}
                />
              ))}
              {list.length === 0 && (
                <div className="flex flex-1 items-center justify-center py-5 text-meta text-ink-mute">
                  {isHover ? '松手放到这里' : '空'}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const REMINDER_ICON: Record<string, string> = {
  plan_stalled: '⏳',
  no_plan: '○',
};

function ProjectCard({
  card,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  card: Card;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  const statusMeta = STATUS_META[card.status];
  const rem = card.reminder;
  const { plans, open_plans: openPlans, updates } = card;
  const hiddenPlans = Math.max(0, openPlans - plans.length);

  return (
    <article
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      title={[`${card.priority}｜${card.name}`, card.description].filter(Boolean).join('\n')}
      style={{ borderLeftColor: PRIORITY_TONE[card.priority] }}
      className={`card-hover cursor-pointer rounded-lg border border-l-[3px] border-line bg-surface px-3 py-2.5 ${
        dragging ? 'opacity-40' : ''
      }`}
    >
      {/* ① 名称 + 状态 */}
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-lead font-medium text-ink">{card.name}</h3>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-micro font-medium ${statusMeta.soft} ${statusMeta.text}`}
        >
          {statusMeta.label}
        </span>
      </div>

      {/* ② 提醒：只有"计划停滞 / 没有计划"会出现在这里 */}
      {rem && (
        <p
          className={`mt-1 flex items-start gap-1 text-meta leading-snug ${REMINDER_LEVEL_CLASS[rem.level]}`}
          title={rem.suggestion}
        >
          <span className="shrink-0">{REMINDER_ICON[rem.kind] ?? '⏳'}</span>
          <span className="min-w-0 flex-1">{rem.detail}</span>
        </p>
      )}

      {/* ③ 未来规划：最多 3 条未完成项 */}
      <div className="mt-2">
        <CardLabel
          icon="⚑"
          text="未来规划"
          note={hiddenPlans > 0 ? `还有 ${hiddenPlans} 条` : undefined}
        />
        {plans.length > 0 ? (
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {plans.map((plan, i) => (
              <li key={i} className="flex items-baseline gap-1.5 text-meta leading-snug">
                <span
                  className={`min-w-0 flex-1 truncate ${
                    plan.status === 'in_progress' ? 'text-ink-soft' : 'text-ink-mute'
                  }`}
                  title={plan.title}
                >
                  {plan.status === 'in_progress' && <span className="mr-0.5 text-accent">▸</span>}
                  {plan.title}
                </span>
                {plan.due && (
                  <span className="shrink-0 text-micro text-ink-mute">{plan.due.slice(5)}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-0.5 text-meta text-ink-mute">没有后续计划</p>
        )}
      </div>

      {/* ④ 最近记录：最多 3 条 */}
      <div className="mt-2">
        <CardLabel icon="✎" text="最近记录" />
        {updates.length > 0 ? (
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {updates.map((u, i) => (
              <li key={i} className="flex items-baseline gap-1.5 text-meta leading-snug">
                <span className="shrink-0 text-micro text-ink-mute">
                  {(SOURCE_META[u.source]?.label ?? '记录').slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-mute" title={u.content}>
                  {u.content}
                </span>
                <span className="shrink-0 text-micro text-ink-mute">{relTime(u.ts)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-0.5 text-meta text-ink-mute">还没有任何记录</p>
        )}
      </div>
    </article>
  );
}

/** 卡片里的小节标题：图标 + 名称 + 可选的右侧说明 */
function CardLabel({ icon, text, note }: { icon: string; text: string; note?: string }) {
  return (
    <div className="flex items-baseline gap-1.5 text-micro tracking-wide text-ink-mute">
      <span className="shrink-0">{icon}</span>
      <span className="font-medium">{text}</span>
      {note && <span className="ml-auto shrink-0">{note}</span>}
    </div>
  );
}
