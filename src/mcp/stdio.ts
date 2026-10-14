import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApp } from '../app.ts';
import { createPmServer } from './server.ts';

/** stdio 传输：本地 Agent / harness 直连。注意 stdout 必须只承载 MCP 协议数据。 */
async function main(): Promise<void> {
  const app = createApp();
  const server = createPmServer(app);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[project-manager] MCP(stdio) 已启动，数据目录：${app.store.paths.dataDir}`,
  );
}

main().catch((err) => {
  console.error('[project-manager] 启动失败：', err);
  process.exit(1);
});
