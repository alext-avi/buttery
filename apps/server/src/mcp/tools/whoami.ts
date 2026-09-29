import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../../http/app';
import type { Principal } from '../../identity/principal';
import { getWhoami } from '../../services/identity';
import { withErrors } from '../respond';

export function registerWhoami(server: McpServer, deps: AppDeps, p: Principal) {
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description: 'Identify the signed-in user, their household and this connection.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    withErrors(async () => getWhoami(deps.db, p, deps.config)),
  );
}
