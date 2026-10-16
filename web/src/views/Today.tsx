import { useState } from 'react';
import { api } from '../api';
import type { Notice } from '../App';
import { Btn, Empty, HealthBadge, Input, PriorityBadge } from '../components/bits';
import { REMINDER_LEVEL_CLASS, reminderRank } from '../lib/format';
import type { Card, Plan, Task } from '../types';

interface Props {
  plan: Plan | null;
  cards: Card[];
  onChanged: () => Promise<void>;
  notify: (n: Notice) => void;
  onOpen: (id: string) => void;
}

/** 今日视图：当日计划清单 + 完成回写项目进展 + 需要关注的项目 */
export function Today({ plan, cards, onChanged, notify, onOpen }: Props) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newProject, setNewProject] = useState('');

  const cardById = new Map(cards.map((c) => [c.id, c]));
  const attention = cards
    .filter((c) => c.reminder !== null)
    .sort((a, b) => reminderRank(b.reminder) - reminderRank(a.reminder));

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const generate = (replace: boolean) =>
    guard(async () => {
      const p = await api.generatePlan({ replace });
      notify({
        kind: 'ok',
        text: `已生成 ${p.date} 计划：${p.tasks.length} 项任务${replace ? '（已覆盖未完成任务）' : ''}`,
      });
      await onChanged();
    });

  const complete = (task: Task, extra: { delta?: number; note?: string } = {}) =>
    guard(async () => {
      await api.completeTask({ task_id: task.id, delta: extra.delta, note: extra.note });
      setExpanded(null);
      const linked = task.project_id ? cardById.get(task.project_id) : undefined;
      notify({
        kind: 'ok',
        text: linked
          ? `已完成「${task.title}」，并写入 ${linked.name} 的进展`
          : `已完成「${task.title}」`,
      });
      await onChanged();
    });

  const addTask = () =>
    guard(async () => {
      if (!newTitle.trim()) throw new Error('任务标题不能为空');
      await api.upsertTask({ title: newTitle.trim(), project_id: newProject || undefined });
      setNewTitle('');
      notify({ kind: 'ok', text: '已加入今日计划' });
      await onChanged();
    });

  const openCount = plan ? plan.tasks.filter((t) => t.status !== 'done').length : 0;
  const doneCount = plan ? plan.tasks.length - openCount : 0;
  const hasPlan = Boolean(plan && plan.status !== 'none' && plan.tasks.length > 0);

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_21.25rem]">
      <section className="rounded-[var(--radius-card)] border border-line bg-surface">
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-title font-semibold text-ink">{plan?.date ?? '今日'}</h2>
            {hasPlan && plan && (
              <span
                className={`rounded px-1.5 py-0.5 text-micro font-medium ${
                  plan.status === 'active'
                    ? 'bg-accent/12 text-accent'
                    : plan.status === 'closed'
                      ? 'bg-ok/12 text-ok'
                      : 'bg-warn/15 text-warn'
                }`}
              >
                {plan.status === 'active' ? '已确认' : plan.status === 'closed' ? '已结束' : '待确认'}
              </span>
            )}
            {hasPlan && (
              <span className="tnum text-meta text-ink-mute">
                {doneCount}/{plan?.tasks.length} 完成
              </span>
            )}
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            {hasPlan && plan?.status === 'proposed' && (
              <Btn
                size="sm"
                disabled={busy}
                onClick={() =>
                  guard(async () => {
                    await api.setPlanStatus('active');
                    notify({ kind: 'ok', text: '计划已确认，开始执行' });
                    await onChanged();
                  })
                }
              >
                确认计划
              </Btn>
            )}
            <Btn size="sm" variant="primary" disabled={busy} onClick={() => void generate(false)}>
              生成计划
            </Btn>
            {openCount > 0 && (
              <Btn
                size="sm"
                variant="ghost"
                disabled={busy}
                title="丢弃未完成任务后，按最新项目状态重新推导"
                onClick={() => void generate(true)}
              >
                重新生成
              </Btn>
            )}
          </div>
        </header>

        {plan?.summary && (
          <p className="border-b border-line bg-surface-2/50 px-4 py-2 text-meta leading-relaxed text-ink-soft">
            {plan.summary}
          </p>
        )}

        {!hasPlan ? (
          <Empty
            title="今天还没有计划"
            hint="点「生成计划」，系统会读取全部项目的进展与路线图，按 阻塞 > 进度落后 > 临近里程碑 > 滞涨 的优先级推导今日任务，并说明每条的理由。"
            action={
              <Btn variant="primary" disabled={busy} onClick={() => void generate(false)}>
                生成今日计划
              </Btn>
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {plan!.tasks.map((t) => {
              const linked = t.project_id ? cardById.get(t.project_id) : undefined;
              const done = t.status === 'done';
              const isOpen = expanded === t.id;
              return (
                <li key={t.id} className={`px-4 py-2.5 ${done ? 'opacity-55' : ''}`}>
                  <div className="flex items-start gap-2.5">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-3.5 shrink-0 cursor-pointer"
                      checked={done}
                      disabled={busy || done}
                      onChange={() => void complete(t)}
                      title="标记完成并写入项目进展"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span
                          className={`text-lead leading-snug font-medium ${
                            done ? 'text-ink-mute line-through' : 'text-ink'
                          }`}
                        >
                          {t.title}
                        </span>
                        {t.estimate && (
                          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-micro text-ink-mute">
                            {t.estimate}
                          </span>
                        )}
                      </div>
                      {t.rationale && !done && (
                        <div className="mt-1 text-meta leading-relaxed text-ink-mute">
                          ↳ {t.rationale}
                        </div>
                      )}
                      {linked && (
                        <button
                          onClick={() => onOpen(linked.id)}
                          className="mt-1.5 inline-flex items-center gap-1.5 rounded bg-surface-2 px-1.5 py-0.5 text-micro text-ink-soft transition-colors hover:text-accent"
                        >
                          <PriorityBadge priority={linked.priority} />
                          {linked.name}
                          <HealthBadge health={linked.health} reason={linked.health_reason} />
                        </button>
                      )}
                    </div>
                    {!done && (
                      <button
                        onClick={() => setExpanded(isOpen ? null : t.id)}
                        className="shrink-0 rounded px-1.5 py-0.5 text-meta text-ink-mute transition-colors hover:text-ink"
                        title="完成并同时上报进度"
                      >
                        完成并记 Δ
                      </button>
                    )}
                  </div>

                  {isOpen && !done && (
                    <CompleteForm
                      busy={busy}
                      withProject={Boolean(t.project_id)}
                      onCancel={() => setExpanded(null)}
                      onSubmit={(v) => void complete(t, v)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
          <Input
            value={newTitle}
            onChange={setNewTitle}
            placeholder="临时加一条任务…"
            className="min-w-[200px] flex-1"
          />
          <select
            value={newProject}
            onChange={(e) => setNewProject(e.target.value)}
            className="rounded-lg border border-line bg-surface px-2 py-1.5 text-body text-ink-soft"
          >
            <option value="">不关联项目</option>
            {cards.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <Btn size="sm" disabled={busy} onClick={() => void addTask()}>
            添加
          </Btn>
        </div>
      </section>

      <aside className="flex flex-col gap-3">
        <section className="rounded-[var(--radius-card)] border border-line bg-surface">
          <header className="border-b border-line px-4 py-3">
            <h2 className="text-lead font-semibold text-ink">计划提醒</h2>
            <p className="mt-0.5 text-meta text-ink-mute">有想做的事，但很久没动了</p>
          </header>
          {attention.length === 0 ? (
            <div className="px-4 py-6 text-center text-body text-ink-mute">
              所有后续计划都在推进中
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {attention.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => onOpen(c.id)}
                    className="w-full px-4 py-2.5 text-left transition-colors hover:bg-surface-2/60"
                  >
                    <div className="flex items-center gap-2">
                      <PriorityBadge priority={c.priority} />
                      <span className="min-w-0 flex-1 truncate text-body font-medium text-ink">
                        {c.name}
                      </span>
                    </div>
                    <div
                      className={`mt-1 text-micro leading-relaxed ${
                        REMINDER_LEVEL_CLASS[c.reminder!.level]
                      }`}
                    >
                      {c.reminder!.detail}
                    </div>
                    <div className="mt-0.5 text-micro text-ink-mute">
                      {c.reminder!.suggestion}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

      </aside>
    </div>
  );
}

function CompleteForm({
  busy,
  withProject,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  withProject: boolean;
  onCancel: () => void;
  onSubmit: (v: { delta?: number; note?: string }) => void;
}) {
  const [delta, setDelta] = useState('5');
  const [note, setNote] = useState('');
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-2.5 py-2">
      {withProject ? (
        <>
          <span className="text-meta text-ink-mute">进度增量</span>
          <input
            type="number"
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            className="tnum w-16 rounded-md border border-line bg-surface px-2 py-1 text-body text-ink"
          />
        </>
      ) : (
        <span className="text-meta text-ink-mute">该任务未关联项目，仅标记完成</span>
      )}
      <input
        value={note}
        placeholder="进展说明（可选）"
        onChange={(e) => setNote(e.target.value)}
        className="min-w-[160px] flex-1 rounded-md border border-line bg-surface px-2 py-1 text-body text-ink placeholder:text-ink-mute"
      />
      <Btn size="sm" variant="primary" disabled={busy} onClick={() => onSubmit({ delta: Number(delta) || undefined, note: note || undefined })}>
        确认完成
      </Btn>
      <Btn size="sm" onClick={onCancel}>
        取消
      </Btn>
    </div>
  );
}
