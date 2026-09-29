import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../http/app';
import type { Principal } from '../identity/principal';
import { MCP_INSTRUCTIONS } from './instructions';
import { registerWhoami } from './tools/whoami';

export function buildMcpServer(deps: AppDeps, p: Principal): McpServer {
  const server = new McpServer({ name: 'buttery', version: '0.1.0' }, { instructions: MCP_INSTRUCTIONS });
  registerWhoami(server, deps, p);
  return server;
}
