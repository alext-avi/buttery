import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../../http/app';
import type { Principal } from '../../identity/principal';
import { upsertFood, UpsertFoodInputSchema } from '../../services/foods';
import { withErrors } from '../respond';

export function registerFoodTools(server: McpServer, deps: AppDeps, p: Principal) {
  server.registerTool(
    'upsert_food',
    {
      title: 'Create or update a food',
      description: 'Teach the catalog about a food: receipt aliases, perishability (shelf_stable or perishable), known shelf life per state, default location, staple flag. Values from the user are recorded as source "user".',
      inputSchema: UpsertFoodInputSchema.shape,
    },
    withErrors(async (args) => upsertFood(deps, p, UpsertFoodInputSchema.parse(args))),
  );
}
