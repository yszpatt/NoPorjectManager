/**
 * MCP 冒烟测试：以真实 stdio 子进程方式连接 MCP 服务，
 * 覆盖 工具枚举 → 全局汇总 → 汇报进展 → 生成当日计划 → 完成任务的完整闭环。
 *
 * 用法： npm run smoke
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = process.cwd();
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/** 隔离的数据目录：冒烟测试不应污染用户真实的 .projectmanager */
const dataDir = path.join(root, '.artifacts', 'smoke-mcp');
fs.rmSync(dataDir, { recursive: true, force: true });

function text(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', tsx, path.join(root, 'src', 'mcp', 'stdio.ts')],
    env: {
      ...process.env,
      PM_DATA_DIR: dataDir,
      NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'pm-smoke', version: '0.0.1' });
  await client.connect(transport);
  let failed = 0;
  const check = (name: string, okFlag: boolean, detail = ''): void => {
    if (!okFlag) failed += 1;
    console.log(`${okFlag ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  };

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  check('tools/list', names.length >= 18, `${names.length} 个工具`);
  console.log(`      ${names.join(', ')}`);

  const resources = await client.listResources();
  check('resources/list', resources.resources.length >= 2, resources.resources.map((r) => r.uri).join(', '));

  const summary = JSON.parse(text(await client.callTool({ name: 'pm_summary', arguments: {} })));
  check('pm_summary', typeof summary.totals?.projects === 'number', `项目数 ${summary.totals?.projects}`);

  const created = JSON.parse(
    text(
      await client.callTool({
        name: 'pm_create_project',
        arguments: {
          id: 'smoke-test',
          name: '冒烟测试项目',
          description: '由 scripts/smoke-mcp.ts 创建',
          status: 'active',
          progress: 10,
          priority: 'P3',
          tags: ['test'],
          roadmap: [{ id: 'r1', title: '打通闭环', due: '2026-10-13' }],
        },
      }),
    ),
  );
  check('pm_create_project', created.id === 'smoke-test' && created.progress === 10);

  const reported = JSON.parse(
    text(
      await client.callTool({
        name: 'pm_report_progress',
        arguments: { id: 'smoke-test', content: '闭环验证中', delta: 15 },
      }),
    ),
  );
  check('pm_report_progress', reported.progress === 25, `progress=${reported.progress}`);

  const detail = JSON.parse(
    text(await client.callTool({ name: 'pm_get_project', arguments: { id: 'smoke-test' } })),
  );
  check('pm_get_project', (detail.timeline ?? []).length >= 2, `事件 ${detail.timeline?.length} 条`);

  const plan = JSON.parse(
    text(
      await client.callTool({
        name: 'pm_generate_daily_plan',
        arguments: { date: '2026-10-12', max_tasks: 6 },
      }),
    ),
  );
  check('pm_generate_daily_plan', Array.isArray(plan.tasks) && plan.tasks.length > 0, `${plan.tasks?.length} 项任务`);

  const target = (plan.tasks as Array<{ id: string; status: string }>).find((t) => t.status !== 'done');
  const done = JSON.parse(
    text(
      await client.callTool({
        name: 'pm_complete_daily_task',
        arguments: { task_id: target!.id, date: '2026-10-12', note: '冒烟测试完成', delta: 5 },
      }),
    ),
  );
  check('pm_complete_daily_task', done.completed?.status === 'done');

  const reminders = JSON.parse(
    text(await client.callTool({ name: 'pm_check_reminders', arguments: {} })),
  );
  check('pm_check_reminders', Array.isArray(reminders.reminders), `${reminders.count} 条提醒`);

  const released = JSON.parse(
    text(
      await client.callTool({
        name: 'pm_report_release',
        arguments: {
          id: 'smoke-test',
          version: 'v0.1.0',
          note: '首次可运行版本',
          url: 'https://example.com/releases/v0.1.0',
        },
      }),
    ),
  );
  check('pm_report_release', released.last_release?.version === 'v0.1.0', `release_count=${released.release_count}`);

  const withTimeline = JSON.parse(
    text(await client.callTool({ name: 'pm_get_project', arguments: { id: 'smoke-test' } })),
  );
  check(
    'pm_get_project 带发布历史',
    Array.isArray(withTimeline.releases) && withTimeline.releases.length === 1,
    `${withTimeline.releases?.length} 条发布`,
  );

  const feed = JSON.parse(
    text(await client.callTool({ name: 'pm_get_feed', arguments: { limit: 20 } })),
  );
  check(
    'pm_get_feed',
    Array.isArray(feed) && feed.some((e: { type: string }) => e.type === 'release'),
    `${feed.length} 条记录`,
  );

  const config = JSON.parse(
    text(await client.callTool({ name: 'pm_get_config', arguments: {} })),
  );
  check('pm_get_config', typeof config.config?.health?.staleAfterDays === 'number');

  const brief = text(await client.callTool({ name: 'pm_brief', arguments: {} }));
  check('pm_brief', brief.includes('项目简报'));

  const removed = JSON.parse(
    text(await client.callTool({ name: 'pm_delete_project', arguments: { id: 'smoke-test', hard: true } })),
  );
  check('pm_delete_project', removed.removed === true);

  const after = JSON.parse(text(await client.callTool({ name: 'pm_summary', arguments: {} })));
  check('清理完成', !JSON.stringify(after).includes('smoke-test'));

  await client.close();
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('冒烟测试异常：', err);
  process.exit(1);
});
