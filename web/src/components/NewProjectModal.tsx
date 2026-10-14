import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Notice } from '../App';
import { Btn, Field, Input, Modal, Select, TextArea } from './bits';
import type { Priority, Status } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void | Promise<void>;
  notify: (n: Notice) => void;
}

const STATUS_OPTIONS = [
  { value: 'idea', label: '想法' },
  { value: 'planning', label: '规划中' },
  { value: 'active', label: '进行中' },
  { value: 'paused', label: '已暂停' },
  { value: 'done', label: '已完成' },
];

function toSlug(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 新建项目只问三件事：叫什么、在做什么、什么时候要。
 * 其余（id、状态、优先级、标签、里程碑、仓库、正文）收进「更多选项」，
 * 因为登记一个项目的成本越低，看板才越可能被持续维护。
 */
export function NewProjectModal({ open, onClose, onCreated, notify }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [target, setTarget] = useState('');
  const [advanced, setAdvanced] = useState(false);

  const [id, setId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [status, setStatus] = useState<Status>('active');
  const [priority, setPriority] = useState<Priority>('P2');
  const [tags, setTags] = useState('');
  const [milestone, setMilestone] = useState('');
  const [milestoneDue, setMilestoneDue] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setName('');
      setDescription('');
      setTarget('');
      setAdvanced(false);
      setId('');
      setIdTouched(false);
      setStatus('active');
      setPriority('P2');
      setTags('');
      setMilestone('');
      setMilestoneDue('');
      setRepoPath('');
      setBody('');
    }
  }, [open]);

  const effectiveId = idTouched ? id : toSlug(name);

  const submit = async () => {
    setBusy(true);
    try {
      if (!name.trim()) throw new Error('请填写项目名称');
      const created = await api.createProject({
        id: effectiveId || undefined,
        name: name.trim(),
        description: description.trim(),
        status,
        priority,
        target_date: target || undefined,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        roadmap: milestone.trim()
          ? [{ title: milestone.trim(), due: milestoneDue || undefined, status: 'planned' }]
          : undefined,
        repos: repoPath.trim() ? [{ path: repoPath.trim() }] : undefined,
        body: body.trim() || undefined,
      });
      await onCreated(created.id);
    } catch (e) {
      notify({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建项目"
      footer={
        <>
          <Btn onClick={onClose}>取消</Btn>
          <Btn variant="primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
            {busy ? '创建中…' : '创建'}
          </Btn>
        </>
      }
    >
      <Field label="项目名称 *">
        <Input value={name} onChange={setName} placeholder="例如 数据管线重构" />
      </Field>

      <Field label="在做什么（一句话）">
        <Input value={description} onChange={setDescription} placeholder="例如 把批处理管线切换到流式架构" />
      </Field>

      <Field label="什么时候要（可选）">
        <Input value={target} onChange={setTarget} type="date" className="w-[180px]" />
      </Field>

      <button
        onClick={() => setAdvanced(!advanced)}
        className="flex items-center gap-1.5 self-start text-[11.5px] text-ink-mute transition-colors hover:text-ink"
      >
        <span className={`text-[9px] transition-transform ${advanced ? 'rotate-90' : ''}`}>▶</span>
        更多选项
      </button>

      {advanced && (
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2/50 p-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="状态">
              <Select value={status} onChange={(v) => setStatus(v as Status)} options={STATUS_OPTIONS} />
            </Field>
            <Field label="优先级">
              <Select
                value={priority}
                onChange={(v) => setPriority(v as Priority)}
                options={['P0', 'P1', 'P2', 'P3'].map((p) => ({ value: p, label: p }))}
              />
            </Field>
          </div>

          <Field label="项目 id（commit 标签用，留空自动生成）">
            <Input
              value={effectiveId}
              onChange={(v) => {
                setIdTouched(true);
                setId(v);
              }}
              placeholder="pipeline-refactor"
            />
          </Field>

          <Field label="标签（逗号分隔）">
            <Input value={tags} onChange={setTags} placeholder="infra, docs" />
          </Field>

          <div>
            <div className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-mute uppercase">
              第一个里程碑（填了才能被每日计划推导）
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input value={milestone} onChange={setMilestone} placeholder="例如 双写灰度上线" className="min-w-[150px] flex-1" />
              <Input value={milestoneDue} onChange={setMilestoneDue} type="date" className="w-[140px]" />
            </div>
          </div>

          <Field label="本地仓库路径（可选，用于采集 commit）">
            <Input value={repoPath} onChange={setRepoPath} placeholder="c:/workspace/my-repo" />
          </Field>

          <Field label="详细介绍（可选，Markdown）">
            <TextArea value={body} onChange={setBody} rows={3} placeholder="## 背景" />
          </Field>

          {!effectiveId && name.trim() !== '' && (
            <p className="text-[11px] text-warn">
              项目名不含 ASCII 字符，将自动生成随机 id。建议填写 id，便于在 commit message 与 CLI 中引用。
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
