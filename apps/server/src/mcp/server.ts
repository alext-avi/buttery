import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../http/app';
import type { Principal } from '../identity/principal';
import { MCP_INSTRUCTIONS } from './instructions';
import { registerActivityTools } from './tools/activity';
import { registerFoodTools } from './tools/foods';
import { registerInventoryTools } from './tools/inventory';
import { registerObservationTools } from './tools/observations';
import { registerWhoami } from './tools/whoami';

export function buildMcpServer(deps: AppDeps, p: Principal): McpServer {
  const server = new McpServer({ name: 'buttery', version: '0.1.0' }, { instructions: MCP_INSTRUCTIONS });
  registerWhoami(server, deps, p);
  registerInventoryTools(server, deps, p);
  registerObservationTools(server, deps, p);
  registerFoodTools(server, deps, p);
  registerActivityTools(server, deps, p);
  return server;
}
