/**
 * 记录合并（core/merge-records.ts）的单元测试。
 *
 * 合并规则直接决定看板上「同一件事会不会出现两次」，配对错比不配更糟，
 * 因此把各种边界都钉住：显式关联、一对一自动配对、多候选放弃、窗口外放弃、
 * 系统审计事件的特殊处理、增量转移。
 */
import { mergeRecords } from '../src/core/merge-records.ts';
import type { Update, UpdateType } from '../src/core/types.ts';

const BASE = Date.parse('2026-10-13T10:00:00.000Z');
/** 相对基准时间偏移 minutes 分钟 */
const at = (minutes: number): string => new Date(BASE + minutes * 60_000).toISOString();

function commit(sha: string, minutes: number, delta?: number, subject?: string): Update {
  return {
    id: `git-${sha}`,
    project_id: 'p',
    ts: at(minutes),
    source: 'git',
    type: delta === undefined ? 'note' : 'progress',
    content: subject ?? `提交 ${sha}`,
    ...(delta === undefined ? {} : { delta }),
    refs: { commit: sha.slice(0, 12), repo: '/repo', ...(subject ? { subject } : {}) },
  };
}

function report(
  id: string,
  minutes: number,
  extra: { refs?: Record<string, string>; delta?: number; type?: UpdateType; auto?: boolean } = {},
): Update {
  return {
    id,
    project_id: 'p',
    ts: at(minutes),
    source: 'agent',
    type: extra.type ?? 'note',
    content: `汇报 ${id}`,
    ...(extra.delta === undefined ? {} : { delta: extra.delta }),
    ...(extra.refs ? { refs: extra.refs } : {}),
    ...(extra.auto ? { auto: true } : {}),
  };
}

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2';

const opts = { windowMinutes: 120 };

// ---- 1. 显式 refs.commit：无条件合并，即使时间隔得很远
{
  const out = mergeRecords(
    [report('r1', 0, { refs: { commit: SHA_A.slice(0, 12) } }), commit(SHA_A, 600)],
    opts,
  );
  check('显式 refs.commit 合并（不受窗口限制）', out.length === 1 && out[0]!.commits.length === 1);
  check('显式合并保留汇报内容', out[0]?.content === '汇报 r1');
}

// ---- 2. 显式 refs.commits：一次并入多个提交
{
  const out = mergeRecords(
    [
      report('r1', 0, { refs: { commits: `${SHA_A.slice(0, 8)}, ${SHA_B.slice(0, 8)}` } }),
      commit(SHA_A, 5),
      commit(SHA_B, 6),
    ],
    opts,
  );
  check('显式 refs.commits 并入多个提交', out.length === 1 && out[0]!.commits.length === 2);
}

// ---- 3. 自动配对：窗口内一对一
{
  const out = mergeRecords([commit(SHA_A, 0), report('r1', 30)], opts);
  check('自动配对：窗口内一对一 → 合并', out.length === 1 && out[0]!.commits[0]?.sha === SHA_A);
}

// ---- 4. 自动配对：两个候选 → 放弃
{
  const out = mergeRecords([commit(SHA_A, 0), report('r1', 20), report('r2', 30)], opts);
  check('自动配对：提交有两个候选 → 不合并', out.length === 3);
}

// ---- 5. 自动配对：窗口外 → 放弃
{
  const out = mergeRecords([commit(SHA_A, 0), report('r1', 300)], opts);
  check('自动配对：超出窗口 → 不合并', out.length === 2);
  const off = mergeRecords([commit(SHA_A, 0), report('r1', 30)], { windowMinutes: 0 });
  check('关闭自动配对后只认显式关联', off.length === 2);
}

// ---- 6. 反向也要唯一：一个汇报挨着两个提交 → 放弃
{
  const out = mergeRecords([commit(SHA_A, 0), commit(SHA_B, 10), report('r1', 5)], opts);
  check('自动配对：汇报挨着两个提交 → 不合并', out.length === 3);
}

// ---- 7. 系统审计事件不作为宿主
{
  const out = mergeRecords([commit(SHA_A, 0), report('sys', 10, { auto: true })], opts);
  check('系统审计事件不吸收提交', out.length === 2);
}

// ---- 8. 系统审计事件反向并入提交（git 采集的「进度 x% → y%」并回引起它的提交）
{
  const out = mergeRecords(
    [commit(SHA_A, 0, 10), report('sys', 0, { auto: true, refs: { commit: SHA_A.slice(0, 12) } })],
    opts,
  );
  check(
    '审计事件并回提交，提交那条保持干净',
    out.length === 1 && out[0]!.id === `git-${SHA_A}` && out[0]!.commits.length === 0,
  );
  check('审计事件并回后不丢增量', out[0]?.delta === 10);

  // 提交自己没写增量时，从被并入的审计事件带过来
  const carried = mergeRecords(
    [commit(SHA_A, 0), report('sys', 0, { auto: true, delta: 7, refs: { commit: SHA_A.slice(0, 12) } })],
    opts,
  );
  check('提交无增量时从审计事件带过增量', carried[0]?.delta === 7);
}

// ---- 9. release 不作为宿主
{
  const out = mergeRecords([commit(SHA_A, 0), report('rel', 10, { type: 'release' })], opts);
  check('发布记录不吸收提交', out.length === 2);
}

// ---- 10. 宿主没写增量时，从提交转移增量
{
  const out = mergeRecords(
    [commit(SHA_A, 0, 10), report('r1', 10, { refs: { commit: SHA_A.slice(0, 12) } })],
    opts,
  );
  check('宿主无增量时从提交带过增量', out[0]?.delta === 10);

  const own = mergeRecords(
    [commit(SHA_A, 0, 10), report('r1', 10, { refs: { commit: SHA_A.slice(0, 12) }, delta: 4 })],
    opts,
  );
  check('宿主自带增量时不被覆盖', own[0]?.delta === 4);
}

// ---- 11. 无人关联的提交保持原样
{
  const out = mergeRecords([commit(SHA_A, 0), commit(SHA_B, 500)], opts);
  check('孤立提交原样保留', out.length === 2 && out.every((r) => r.commits.length === 0));
  check('提交记录本身不把自己列进 commits', out[0]?.source === 'git' && out[0]?.commits.length === 0);
}

// ---- 12. 跨项目不配对
{
  const other = { ...report('r1', 10), project_id: 'q' };
  const out = mergeRecords([commit(SHA_A, 0), other], opts);
  check('不同项目之间不配对', out.length === 2);
}

// ---- 13. 三个事件都落在窗口内时，提交有两个候选 → 谁都不并（宁可不并）
{
  const out = mergeRecords([report('r1', 30), commit(SHA_A, 40), report('r2', 10)], opts);
  check('窗口内多候选时保持三条原始记录', out.length === 3);
}

// ---- 14. 合并保留原始顺序与宿主来源
{
  // r2 远离窗口，提交与 r1 构成一对一
  const out = mergeRecords([report('r1', 30), commit(SHA_A, 40), report('r2', 900)], opts);
  check('合并后仍按输入顺序返回', out.map((r) => r.id).join(',') === 'r1,r2');
  check('宿主来源保持 agent', out[0]?.source === 'agent');
}

console.log(`\n${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：\n  ' + failures.join('\n  '));
  process.exitCode = 1;
}
