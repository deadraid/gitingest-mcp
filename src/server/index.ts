#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createMcpServer } from './create-server.js';
import { isMainModule } from './is-main-module.js';

export async function startStdioServer(): Promise<void> {
  const server = createMcpServer({
    allowUnrestrictedLocalRepositories: true,
    allowUnrestrictedRemoteRepositories: true,
    allowInsecureRemoteRepositories: true,
    allowSubmodules: true,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Gitingest MCP server started');
}

if (isMainModule(import.meta.url)) {
  startStdioServer().catch((error) => {
    console.error('Server error:', error);
    process.exitCode = 1;
  });
}

export { createMcpServer } from './create-server.js';
