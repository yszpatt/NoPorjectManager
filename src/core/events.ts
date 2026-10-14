/** 极简事件总线：所有写入都会广播，供未来外部集成订阅。 */
import type { Update } from './types.ts';

export type PmEvent =
  | { kind: 'project.created'; project_id: string; at: string }
  | { kind: 'project.updated'; project_id: string; at: string; fields: string[] }
  | { kind: 'project.archived'; project_id: string; at: string }
  | { kind: 'project.deleted'; project_id: string; at: string }
  | { kind: 'update.appended'; project_id: string; at: string; update: Update }
  | { kind: 'plan.written'; date: string; at: string }
  | { kind: 'index.rebuilt'; at: string };

type Handler = (e: PmEvent) => void;

const handlers = new Set<Handler>();

export function onEvent(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}

export function emitEvent(e: PmEvent): void {
  for (const h of handlers) {
    try {
      h(e);
    } catch {
      // 订阅者异常不影响主流程
    }
  }
}
