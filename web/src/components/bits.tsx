import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Health, LinkedCommit, Priority, Source, Status } from '../types';
import {
  HEALTH_META,
  PRIORITY_META,
  SOURCE_META,
  STATUS_META,
  clamp,
} from '../lib/format';

/* ------------------------------------------------------------------ 进度环 */

export function ProgressRing({
  value,
  size = 38,
  stroke = 3.5,
  tone = 'var(--color-accent)',
  label,
}: {
  value: number;
  size?: number;
  stroke?: number;
  tone?: string;
  label?: string;
}) {
  const v = clamp(value, 0, 100);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - v / 100);
  const center = size / 2;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} title={label ?? `${v}%`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke="var(--color-line)"
          strokeWidth={stroke}
        />
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset .4s cubic-bezier(.22,1,.36,1)' }}
        />
      </svg>
      <span
        className="tnum absolute inset-0 flex items-center justify-center font-semibold text-ink"
        style={{ fontSize: size <= 34 ? 12 : 14 }}
      >
        {Math.round(v)}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ 迷你趋势 */

export function Sparkline({
  points,
  width = 96,
  height = 26,
  tone = 'var(--color-accent)',
}: {
  points: number[];
  width?: number;
  height?: number;
  tone?: string;
}) {
  if (points.length < 2) {
    return (
      <div className="flex items-center text-meta text-ink-mute" style={{ height }}>
        样本不足
      </div>
    );
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = i * stepX;
    const y = height - 2 - ((p - min) / span) * (height - 5);
    return [x, y] as const;
  });
  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const id = `sp-${Math.round(points[0]! * 1000)}-${points.length}`;
  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={tone} stopOpacity="0.22" />
          <stop offset="100%" stopColor={tone} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={tone} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={coords.at(-1)![0]} cy={coords.at(-1)![1]} r="2.2" fill={tone} />
    </svg>
  );
}

/* ------------------------------------------------------------------ 标签 */

export function Chip({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent';
  title?: string;
}) {
  const cls =
    tone === 'accent'
      ? 'bg-accent/10 text-accent'
      : 'bg-surface-2 text-ink-soft border border-line';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-meta font-medium ${cls}`}
      title={title}
    >
      {children}
    </span>
  );
}

export function HealthBadge({ health, reason }: { health: Health; reason?: string }) {
  const m = HEALTH_META[health];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-meta font-medium ${m.soft} ${m.text}`}
      title={reason}
    >
      <span className={`size-1.5 rounded-full ${m.bg}`} />
      {m.label}
    </span>
  );
}

export function StatusBadge({ status }: { status: Status }) {
  const m = STATUS_META[status];
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-meta font-medium ${m.soft} ${m.text}`}>
      {m.label}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  const m = PRIORITY_META[priority];
  return (
    <span className={`text-meta font-bold tracking-wide ${m.text}`} title={`优先级 ${priority}`}>
      {m.label}
    </span>
  );
}

export function SourceBadge({ source, ts }: { source: Source; ts?: string }) {
  const m = SOURCE_META[source];
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-micro font-medium ${m.soft} ${m.text}`}
      title={ts ? `${ts}` : undefined}
    >
      {m.label}
    </span>
  );
}

/**
 * 并入本条记录的提交。
 * 显示短 sha，悬停可看原始提交标题——合并是自动的，得让人能核对。
 */
export function CommitChip({ commits }: { commits?: LinkedCommit[] }) {
  if (!commits?.length) return null;
  const title = commits.map((c) => `${c.sha.slice(0, 8)}  ${c.subject ?? ''}`).join('\n');
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded bg-surface-2 px-1.5 py-px font-mono text-micro text-ink-mute"
      title={`已并入的提交：\n${title}`}
    >
      {commits[0]!.sha.slice(0, 7)}
      {commits.length > 1 && <span className="tnum">+{commits.length - 1}</span>}
    </span>
  );
}

/* ------------------------------------------------------------------ 按钮与输入 */

export function Btn({
  children,
  onClick,
  variant = 'ghost',
  size = 'md',
  disabled,
  type = 'button',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'subtle' | 'danger';
  size?: 'sm' | 'md';
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-45 disabled:cursor-not-allowed';
  const sizes = size === 'sm' ? 'px-2.5 py-1 text-meta' : 'px-3.5 py-1.5 text-body';
  const variants = {
    primary: 'bg-accent text-white hover:opacity-90',
    ghost: 'border border-line bg-surface text-ink-soft hover:text-ink hover:border-line-strong',
    subtle: 'bg-surface-2 text-ink-soft hover:text-ink',
    danger: 'border border-danger/35 text-danger hover:bg-danger/10',
  }[variant];
  return (
    <button type={type} className={`${base} ${sizes} ${variants}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`rounded-lg border border-line bg-surface px-2.5 py-1.5 text-body text-ink placeholder:text-ink-mute ${className}`}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full resize-y rounded-lg border border-line bg-surface px-2.5 py-2 text-body leading-relaxed text-ink placeholder:text-ink-mute"
    />
  );
}

export function Select({
  value,
  onChange,
  options,
  className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`rounded-lg border border-line bg-surface px-2 py-1.5 text-body text-ink ${className}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-meta font-medium tracking-wide text-ink-mute uppercase">{label}</span>
      {children}
    </label>
  );
}

/* ------------------------------------------------------------------ 容器 */

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-[var(--radius-card)] border border-line bg-surface ${className}`}>
      {children}
    </section>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <div className="text-lead font-medium text-ink-soft">{title}</div>
      {hint && <div className="max-w-md text-body leading-relaxed text-ink-mute">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** 右侧抽屉：ESC 关闭 + 锁滚动。宽度用 rem，跟着字号档位一起变宽 */
export function Drawer({
  open,
  onClose,
  children,
  width = 40,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** 抽屉宽度（rem）：40rem = 640px @ 16px 根字号，字号调大时同步变宽 */
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/35 backdrop-blur-[1px]" onClick={onClose} />
      <div
        className="slide-in relative h-full overflow-y-auto border-l border-line bg-canvas shadow-2xl"
        style={{ width: `min(${width}rem, 96vw)` }}
      >
        {children}
      </div>
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="fade-up relative w-full max-w-lg rounded-[var(--radius-card)] border border-line bg-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-lead font-semibold text-ink">{title}</h2>
          <button onClick={onClose} className="text-ink-mute transition-colors hover:text-ink" aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="flex flex-col gap-3.5 px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** 骨架屏，避免加载闪烁 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-line/60 ${className}`} />;
}

/**
 * 可折叠区块。默认收起次要信息，让抽屉首屏只留"需要看/需要做"的部分。
 */
export function Collapsible({
  title,
  count,
  hint,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: number;
  hint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-line">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-5 py-3 text-left transition-colors hover:bg-surface-2/50"
      >
        <span
          className={`text-micro text-ink-mute transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden
        >
          ▶
        </span>
        <span className="text-body font-semibold text-ink">{title}</span>
        {count !== undefined && <span className="tnum text-meta text-ink-mute">{count}</span>}
        {hint && <span className="truncate text-micro text-ink-mute">· {hint}</span>}
      </button>
      {open && <div className="pb-3.5">{children}</div>}
    </section>
  );
}

/** 下拉菜单：把低频操作收起来，保持顶栏安静 */
export function Menu({
  items,
  label = '⋯',
  title,
}: {
  items: Array<{ label: string; onClick: () => void; danger?: boolean }>;
  label?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        title={title}
        className="grid size-7 place-items-center rounded-lg border border-line text-ink-mute transition-colors hover:text-ink"
      >
        {label}
      </button>
      {open && (
        <div className="fade-up absolute top-full right-0 z-40 mt-1 min-w-[168px] rounded-lg border border-line bg-surface py-1 shadow-xl">
          {items.map((i) => (
            <button
              key={i.label}
              onClick={() => {
                setOpen(false);
                i.onClick();
              }}
              className={`block w-full px-3 py-1.5 text-left text-body transition-colors hover:bg-surface-2 ${
                i.danger ? 'text-danger' : 'text-ink-soft hover:text-ink'
              }`}
            >
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  title?: string;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      title={title}
      className="flex items-center gap-2 text-meta text-ink-soft transition-colors hover:text-ink"
    >
      <span
        className={`relative inline-block h-4 w-7 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-line-strong'
        }`}
      >
        <span
          className={`absolute top-0.5 size-3 rounded-full bg-white transition-all ${
            checked ? 'left-3.5' : 'left-0.5'
          }`}
        />
      </span>
      {label}
    </button>
  );
}
