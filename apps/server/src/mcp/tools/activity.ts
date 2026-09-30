import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../../http/app';
import type { Principal } from '../../identity/principal';
import { correctItem, CorrectItemInputSchema, getChanges, GetChangesInputSchema, logActivity, LogActivityInputSchema, logText, LogTextInputSchema } from '../../services/activity';
import { withErrors } from '../respond';

export function registerActivityTools(server: McpServer, deps: AppDeps, p: Principal) {
  server.registerTool(
    'log_activity',
    {
      title: 'Log what happened',
      description: [
        'Record something the user did with food: used (optionally quantity.fraction 0.5 = half, or an amount+unit), finished, discarded, froze, thawed, opened, moved (to_location), or bought (without a receipt).',
        'Name the food (food_name) or pass a specific lot_id. With several items of the same food, Buttery uses the one expiring first and says so in assumptions.',
        'Applied immediately in one change set; freezing/opening/thawing re-estimates expiry. Tell the user the applied[].summary lines and that they can undo (undo with change_set_id).',
        'Anything in unresolved was NOT applied: ask the user which item they meant.',
      ].join(' '),
      inputSchema: LogActivityInputSchema.shape,
    },
    withErrors(async (args) => logActivity(deps, p, LogActivityInputSchema.parse(args))),
  );

  server.registerTool(
    'log_text',
    {
      title: "Log the user's own words",
      description:
        'Pass what the user said verbatim ("we used half the milk and froze the chicken"). Crusoe parses it against current inventory. status "applied": tell the user what changed. status "needs_confirmation": nothing changed; read the interpretation back, resolve the ambiguities with the user, then call log_activity with explicit lot_ids. Prefer log_activity when you can structure a clear statement yourself.',
      inputSchema: LogTextInputSchema.shape,
    },
    withErrors(async (args) => logText(deps, p, LogTextInputSchema.parse(args))),
  );

  server.registerTool(
    'correct_item',
    {
      title: 'Correct an item',
      description: "Fix an item's amount, location, printed expiry date or state (sealed/opened/frozen/thawed). Expiry is recomputed. Undoable.",
      inputSchema: CorrectItemInputSchema.shape,
    },
    withErrors(async (args) => correctItem(deps, p, CorrectItemInputSchema.parse(args))),
  );

  server.registerTool(
    'get_changes',
    {
      title: 'What changed',
      description: 'Recent change sets, newest first: label, items affected, who and via which client, and whether it was undone. Each has a change_set_id for undo.',
      inputSchema: GetChangesInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    withErrors(async (args) => getChanges(deps, p, GetChangesInputSchema.parse(args))),
  );
}
