import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { IdempotencyKeySchema } from '@buttery/domain';
import type { AppDeps } from '../../http/app';
import type { Principal } from '../../identity/principal';
import { undoChangeSet } from '../../services/changes';
import { resolveProposal, ResolveProposalInputSchema } from '../../services/proposals';
import { submitReceipt, SubmitReceiptInputSchema } from '../../services/receipts';
import { withErrors } from '../respond';

export function registerObservationTools(server: McpServer, deps: AppDeps, p: Principal) {
  server.registerTool(
    'submit_observation',
    {
      title: 'Submit a receipt',
      description: [
        'Record a receipt the user shared (this version supports kind "receipt").',
        'Transcribe EVERY printed line in order into payload.lines[].raw_text exactly as printed, including coupons, returns and non-food lines (tag them with line_kind).',
        'Put the bought quantity in quantity (e.g. 4 for "4 @ 0.99", 1.25 with unit "lb" for weighed produce), prices in cents, and printed package details in hint.package (e.g. "2X32 OZ" → {count: 2, size: 32, unit: "oz"}).',
        'Do not guess expiry dates or storage. The server canonicalizes items, matches existing inventory, estimates shelf life and builds a proposal.',
        'Nothing is added to inventory until the user approves. Follow the returned verdict: safe_to_apply → ask for a yes in chat, then resolve_proposal(accept_remaining); quick_check → read lines_to_check to the user first; needs_review → give the user the review_url.',
        'If the result has duplicate_of, the receipt was already recorded; say so and share the existing link.',
      ].join(' '),
      inputSchema: SubmitReceiptInputSchema.shape,
    },
    withErrors(async (args) => submitReceipt(deps, p, SubmitReceiptInputSchema.parse(args))),
  );

  server.registerTool(
    'resolve_proposal',
    {
      title: 'Resolve a proposal',
      description:
        'Apply the user\'s review decisions. Prefer sending the user the review_url; use this when the user gives decisions in chat (e.g. "looks good, add it all" → accept_remaining: true, apply: true). Edits can change a line\'s food, quantity, location or printed expiry date. Coupon, non-food and return lines never create inventory. The result includes undo.change_set_id.',
      inputSchema: ResolveProposalInputSchema.shape,
    },
    withErrors(async (args) => resolveProposal(deps, p, ResolveProposalInputSchema.parse(args))),
  );

  server.registerTool(
    'undo',
    {
      title: 'Undo a change set',
      description: 'Reverse a committed change set (e.g. an applied receipt) with compensating changes. History keeps both. Refuses if the items changed since.',
      inputSchema: { change_set_id: z.uuid(), idempotency_key: IdempotencyKeySchema },
      annotations: { destructiveHint: true },
    },
    withErrors(async (args: { change_set_id: string; idempotency_key: string }) => undoChangeSet(deps.db, p, args)),
  );
}
