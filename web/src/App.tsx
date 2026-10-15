import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ProjectFilters } from './api';
import { Board } from './views/Board';
import { Feed } from './views/Feed';
import { TableView } from './views/TableView';
import { Today } from './views/Today';
import { ProjectDrawer } from './components/ProjectDrawer';
import { NewProjectModal } from './components/NewProjectModal';
import { SettingsModal } from './components/SettingsModal';
import { Btn, Input, Menu, Skeleton } from './components/bits';
import type { Card, Plan, RiskItem, Summary } from './types';

type ViewKey = 'board' | 'feed' | 'today' | 'table';

const VIEWS: Array<{ key: ViewKey; label: string }> = [
  { key: 'board', label: '看板' },
  { key: 'feed', label: '动态流' },
  { key: 'today', label: '今日' },
  { key: 'table', label: '表格' },
];

/** 顶栏统计即筛选：只看「正在做的」 */
type Focus = 'active' | null;

export interface Notice {
  kind: 'ok' | 'err';
  text: string;
}

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('pm-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  const [view, setView] = useState<ViewKey>('board');
  const [focus, setFocus] = useState<Focus>(null);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 220);
  const [showArchived, setShowArchived] = useState(false);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [reminders, setReminders] = useState<RiskItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [notice, setNotice] = useState<Notice | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  /** 看板名称来自 config，可以在「设置」里改 */
  const [projectName, setProjectName] = useState('项目看板');
  const loadProjectName = useCallback(() => {
    void api
      .config()
      .then((r) => setProjectName(r.config.projectName?.trim() || '项目看板'))
      .catch(() => {
        /* 读不到就用默认名字，不打扰用户 */
      });
  }, []);

  useEffect(() => {
    loadProjectName();
  }, [loadProjectName]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('pm-theme', theme);
  }, [theme]);

  const notify = useCallback((n: Notice) => {
    setNotice(n);
    window.setTimeout(() => setNotice((cur) => (cur === n ? null : cur)), 4200);
  }, []);

  const filters: ProjectFilters = useMemo(() => {
    const base: ProjectFilters = {
      query: debouncedQuery || undefined,
      all: showArchived,
    };
    if (focus === 'active') return { ...base, status: ['active'] };
    return base;
  }, [debouncedQuery, focus, showArchived]);

  const refresh = useCallback(async () => {
    try {
      const [s, list, p, rem] = await Promise.all([
        api.summary(),
        api.cards(filters),
        api.plan(),
        api.reminders(),
      ]);
      setSummary(s);
      setCards(list.projects);
      setPlan(p);
      setReminders(rem.reminders);
    } catch (e) {
      notify({ kind: 'err', text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [filters, notify]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const runGitSync = async () => {
    setSyncing(true);
    try {
      const r = await api.syncGit();
      notify({
        kind: 'ok',
        text:
          r.events_created > 0
            ? `采集到 ${r.events_created} 条新提交记录`
            : '没有新的提交需要采集',
      });
      await refresh();
    } catch (e) {
      notify({ kind: 'err', text: (e as Error).message });
    } finally {
      setSyncing(false);
    }
  };

  const activeCount = summary?.totals.active ?? 0;
  const staleCount = reminders.length;
  const openTasks = plan && plan.status !== 'none' ? plan.tasks.filter((t) => t.status !== 'done').length : 0;
  const totalTasks = plan && plan.status !== 'none' ? plan.tasks.length : 0;

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/88 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-2 px-5 py-2.5">
          <div className="flex items-center gap-2">
            <span className="grid size-6 place-items-center rounded-md bg-accent text-[12px] font-bold text-white">
              P
            </span>
            <h1 className="text-[14px] font-semibold tracking-tight text-ink">{projectName}</h1>
          </div>

          <nav className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                onClick={() => setView(v.key)}
                className={`rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors ${
                  view === v.key ? 'bg-surface text-ink shadow-sm' : 'text-ink-mute hover:text-ink-soft'
                }`}
              >
                {v.label}
              </button>
            ))}
          </nav>

          {/* 统计本身就是筛选器，省掉一整排筛选按钮 */}
          <div className="hidden items-center gap-1 text-[12px] text-ink-soft lg:flex">
            <FocusStat
              label="在做"
              value={activeCount}
              active={focus === 'active'}
              onClick={() => setFocus(focus === 'active' ? null : 'active')}
            />
            <span className="text-line">·</span>
            <button
              onClick={() => setView('feed')}
              title="打开动态流查看计划提醒"
              className={`inline-flex items-baseline gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-surface-2 ${
                staleCount > 0 ? 'text-danger' : 'text-ink-soft'
              }`}
            >
              <span className="text-ink-mute">计划停滞</span>
              <span className="tnum font-semibold">{staleCount}</span>
            </button>
            <span className="text-line">·</span>
            <button
              onClick={() => setView('today')}
              title="打开今日计划"
              className="tnum rounded px-1.5 py-0.5 text-ink-mute transition-colors hover:bg-surface-2 hover:text-ink-soft"
            >
              {totalTasks === 0
                ? '今日无计划'
                : openTasks === 0
                  ? '今日已清空 ✓'
                  : `今日 ${openTasks} 项待办`}
            </button>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <Input value={query} onChange={setQuery} placeholder="搜索…" className="w-36" />
            <Menu
              title="更多操作"
              items={[
                { label: '刷新数据', onClick: () => void refresh() },
                { label: syncing ? '同步中…' : '同步 Git 提交', onClick: () => void runGitSync() },
                {
                  label: showArchived ? '隐藏已归档' : '显示已归档',
                  onClick: () => setShowArchived(!showArchived),
                },
                { label: '设置', onClick: () => setSettingsOpen(true) },
              ]}
            />
            <Btn size="sm" variant="primary" onClick={() => setCreating(true)}>
              + 新建
            </Btn>
            <button
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className="grid size-7 place-items-center rounded-lg border border-line text-ink-mute transition-colors hover:text-ink"
              title="切换深浅色"
            >
              {theme === 'dark' ? '☾' : '☀'}
            </button>
          </div>
        </div>

        {notice && (
          <div
            className={`fade-up border-t px-5 py-1.5 text-[12px] ${
              notice.kind === 'ok'
                ? 'border-ok/20 bg-ok/8 text-ok'
                : 'border-danger/20 bg-danger/8 text-danger'
            }`}
          >
            {notice.text}
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-5 py-5">
        {loading && cards.length === 0 ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : view === 'board' ? (
          <Board cards={cards} onOpen={setSelected} onChanged={refresh} notify={notify} />
        ) : view === 'feed' ? (
          <Feed cards={cards} onOpen={setSelected} />
        ) : view === 'today' ? (
          <Today plan={plan} cards={cards} onChanged={refresh} notify={notify} onOpen={setSelected} />
        ) : (
          <TableView cards={cards} onOpen={setSelected} />
        )}
      </main>

      <ProjectDrawer
        projectId={selected}
        onClose={() => setSelected(null)}
        onChanged={refresh}
        notify={notify}
      />

      <NewProjectModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={async (id) => {
          setCreating(false);
          await refresh();
          notify({ kind: 'ok', text: `项目 ${id} 已创建` });
        }}
        notify={notify}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        notify={notify}
        onConfigSaved={loadProjectName}
      />
    </div>
  );
}

/** 可点击的统计项：既是数字也是筛选入口 */
function FocusStat({
  label,
  value,
  onClick,
  active,
  tone,
}: {
  label: string;
  value: number;
  onClick: () => void;
  active: boolean;
  tone?: 'danger';
}) {
  const emphasize = tone === 'danger' && value > 0;
  return (
    <button
      onClick={onClick}
      title={active ? '点击取消筛选' : `只看${label}`}
      className={`inline-flex items-baseline gap-1 rounded px-1.5 py-0.5 transition-colors ${
        active ? 'bg-accent/12 ring-1 ring-accent/30' : 'hover:bg-surface-2'
      }`}
    >
      <span className="text-ink-mute">{label}</span>
      <span className={`tnum font-semibold ${emphasize ? 'text-danger' : 'text-ink'}`}>{value}</span>
    </button>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer.current);
  }, [value, ms]);
  return debounced;
}
