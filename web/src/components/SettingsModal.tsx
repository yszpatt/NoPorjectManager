import { useEffect, useState } from 'react';
import { api, type AuthStatus } from '../api';
import { Btn, Field, Input, Modal } from './bits';
import type { Notice } from '../App';

interface Props {
  open: boolean;
  onClose: () => void;
  notify: (n: Notice) => void;
  /** 常用配置保存后回调，让顶栏标题等立即跟上 */
  onConfigSaved: () => void;
}

/**
 * 面板设置。
 *
 * 凭据的保存/清除会立刻改变服务端校验用的那一套口令，所以这两种操作成功后
 * 直接刷新页面：浏览器会拿旧凭据再问一次，从而弹出登录框要求重新登录。
 * 常用配置只是字段变更，就地生效，不刷新。
 */
export function SettingsModal({ open, onClose, notify, onConfigSaved }: Props) {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [user, setUser] = useState('pm');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [savingAuth, setSavingAuth] = useState(false);

  const [projectName, setProjectName] = useState('');
  const [maxTasks, setMaxTasks] = useState('5');
  const [savingConfig, setSavingConfig] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPassword('');
    setConfirm('');
    void api
      .authStatus()
      .then((s) => {
        setAuth(s);
        setUser(s.user);
      })
      .catch((e: Error) => notify({ kind: 'err', text: e.message }));
    void api
      .config()
      .then((r) => {
        setProjectName(r.config.projectName ?? '');
        setMaxTasks(String(r.config.planning?.maxTasksPerDay ?? 5));
      })
      .catch(() => {
        /* 读配置失败不该挡住鉴权设置 */
      });
  }, [open, notify]);

  const minLen = auth?.min_password_length ?? 6;

  const saveAuth = async () => {
    const name = user.trim();
    if (!name) return notify({ kind: 'err', text: '用户名不能为空' });
    if (password.length < minLen) return notify({ kind: 'err', text: `口令至少 ${minLen} 位` });
    if (password !== confirm) return notify({ kind: 'err', text: '两次输入的口令不一致' });
    setSavingAuth(true);
    try {
      await api.setAuth(name, password);
      notify({ kind: 'ok', text: '已更新访问凭据，请用新口令登录' });
      window.setTimeout(() => window.location.reload(), 700);
    } catch (e) {
      notify({ kind: 'err', text: (e as Error).message });
      setSavingAuth(false);
    }
  };

  const clearAuth = async () => {
    const after = auth?.env_configured
      ? '服务会回落到环境变量里的口令'
      : '服务之后将不再校验凭据';
    if (
      !window.confirm(
        `确定关闭鉴权？\n\n${after}。同网络内的任何人都能读写、归档甚至删除看板数据。`,
      )
    ) {
      return;
    }
    setSavingAuth(true);
    try {
      await api.clearAuth();
      notify({ kind: 'ok', text: '已清除面板凭据' });
      window.setTimeout(() => window.location.reload(), 700);
    } catch (e) {
      notify({ kind: 'err', text: (e as Error).message });
      setSavingAuth(false);
    }
  };

  const saveConfig = async () => {
    const n = Number(maxTasks);
    if (!Number.isInteger(n) || n < 1) {
      return notify({ kind: 'err', text: '每日任务上限要是正整数' });
    }
    setSavingConfig(true);
    try {
      await api.updateConfig({
        projectName: projectName.trim() || '项目看板',
        planning: { maxTasksPerDay: n },
      });
      notify({ kind: 'ok', text: '设置已保存' });
      onConfigSaved();
    } catch (e) {
      notify({ kind: 'err', text: (e as Error).message });
    } finally {
      setSavingConfig(false);
    }
  };

  const sourceText = !auth
    ? '读取中…'
    : auth.source === 'file'
      ? `由面板管理（用户名 ${auth.user}）`
      : auth.source === 'env'
        ? `由环境变量控制（用户名 ${auth.user}）`
        : '未启用 —— 同网络内任何人都能改数据';

  return (
    <Modal open={open} onClose={onClose} title="设置" footer={<Btn onClick={onClose}>关闭</Btn>}>
      <section className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
          <h3 className="text-[12.5px] font-semibold text-ink">访问鉴权</h3>
          <span className={`text-[11px] ${auth?.enabled ? 'text-ink-mute' : 'text-danger'}`}>
            {sourceText}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <Field label="用户名">
            <Input value={user} onChange={setUser} placeholder="pm" />
          </Field>
          <Field label={`口令（≥${minLen} 位）`}>
            <Input value={password} onChange={setPassword} type="password" />
          </Field>
          <Field label="再输一次">
            <Input value={confirm} onChange={setConfirm} type="password" />
          </Field>
        </div>

        <p className="text-[11px] leading-relaxed text-ink-mute">
          口令只以 scrypt 派生值落盘（<code className="rounded bg-surface-2 px-1">{auth?.file ?? '…'}</code>
          ），不存明文，所以还留着找回的余地：忘了口令就用{' '}
          <code className="rounded bg-surface-2 px-1">pm auth reset</code> 清掉它重新设置。
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Btn size="sm" variant="primary" disabled={savingAuth} onClick={() => void saveAuth()}>
            {savingAuth ? '保存中…' : auth?.enabled ? '更新凭据' : '启用鉴权'}
          </Btn>
          {auth?.enabled && (
            <Btn size="sm" variant="danger" disabled={savingAuth} onClick={() => void clearAuth()}>
              关闭鉴权
            </Btn>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-2.5 border-t border-line pt-3.5">
        <h3 className="text-[12.5px] font-semibold text-ink">常用</h3>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <Field label="看板名称">
            <Input value={projectName} onChange={setProjectName} placeholder="项目看板" />
          </Field>
          <Field label="每日计划任务上限">
            <Input value={maxTasks} onChange={setMaxTasks} type="number" />
          </Field>
        </div>
        <div className="flex items-center gap-2">
          <Btn size="sm" variant="primary" disabled={savingConfig} onClick={() => void saveConfig()}>
            {savingConfig ? '保存中…' : '保存'}
          </Btn>
        </div>
      </section>
    </Modal>
  );
}
