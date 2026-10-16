import type { ReactNode } from 'react';

/**
 * 极简 Markdown 渲染：只支持标题、列表、代码块、段落与行内强调。
 * 刻意不引入第三方依赖，也不使用 dangerouslySetInnerHTML。
 */
export function Markdown({ text }: { text: string }) {
  const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let code: string[] | null = null;
  let paragraph: string[] = [];

  const flushList = () => {
    if (!list.length) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="my-1.5 list-disc space-y-1 pl-5">
        {list.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(
      <p key={`p-${blocks.length}`} className="my-1.5 leading-relaxed">
        {inline(paragraph.join(' '))}
      </p>,
    );
    paragraph = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim().startsWith('```')) {
      if (code) {
        blocks.push(
          <pre
            key={`pre-${blocks.length}`}
            className="my-2 overflow-x-auto rounded-lg border border-line bg-surface-2 px-3 py-2 text-meta leading-relaxed"
          >
            <code>{code.join('\n')}</code>
          </pre>,
        );
        code = null;
      } else {
        flushList();
        flushParagraph();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(raw);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      flushParagraph();
      const level = heading[1]!.length;
      const content = inline(heading[2] ?? '');
      const cls =
        level <= 2
          ? 'mt-4 mb-1.5 text-title font-semibold text-ink'
          : 'mt-3 mb-1 text-body font-semibold text-ink-soft';
      blocks.push(
        <div key={`h-${blocks.length}`} className={cls}>
          {content}
        </div>,
      );
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1] ?? '');
      continue;
    }

    if (!line.trim()) {
      flushList();
      flushParagraph();
      continue;
    }

    paragraph.push(line);
  }

  flushList();
  flushParagraph();
  if (code) {
    blocks.push(
      <pre key="pre-tail" className="my-2 overflow-x-auto rounded-lg border border-line bg-surface-2 px-3 py-2 text-meta">
        <code>{code.join('\n')}</code>
      </pre>,
    );
  }

  return <div className="text-body text-ink-soft">{blocks}</div>;
}

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('**')) {
      parts.push(
        <strong key={key++} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      parts.push(
        <code
          key={key++}
          className="rounded border border-line bg-surface-2 px-1 py-px font-mono text-meta text-ink"
        >
          {token.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
