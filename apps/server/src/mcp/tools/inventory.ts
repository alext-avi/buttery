import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../../http/app';
import type { Principal } from '../../identity/principal';
import { getHouseholdSummary, getItem, searchInventory, SearchInventoryInputSchema } from '../../services/inventory';
import { withErrors } from '../respond';

export function registerInventoryTools(server: McpServer, deps: AppDeps, p: Principal) {
  server.registerTool(
    'get_household_summary',
    {
      title: 'Household summary',
      description:
        'START HERE in every new conversation. Compact current state from the authoritative records: items on hand by location, what to use soon (expired / urgent ≤2 days / soon ≤7 days, with printed vs estimated dates), what needs review (with review links), recent changes (with change_set_id for undo) and links to the web views.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    withErrors(async () => getHouseholdSummary(deps, p)),
  );

  server.registerTool(
    'search_inventory',
    {
      title: 'Search inventory',
      description: 'Find items on hand by name, location, perishability or expiry window. Each item includes quantity (with "~" if approximate), expiry text ("est." = estimate, "exp" = printed) and a link.',
      inputSchema: SearchInventoryInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    withErrors(async (args) => searchInventory(deps, p, SearchInventoryInputSchema.parse(args))),
  );

  server.registerTool(
    'get_item',
    {
      title: 'Item detail',
      description: 'Everything about one item: the current belief, the evidence behind it (e.g. the receipt line), how its expiry was estimated and by which model, and its change history.',
      inputSchema: { lot_id: z.uuid() },
      annotations: { readOnlyHint: true },
    },
    withErrors(async (args: { lot_id: string }) => getItem(deps, p, args.lot_id)),
  );
}
