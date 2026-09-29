import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { observations, proposalOps, proposals, PROPOSAL_STATUSES } from '../db/schema';

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export function deriveProposalStatus(ops: Array<{ decision: string; appliedAt: Date | null }>): ProposalStatus {
  const open = ops.filter((o) => o.decision === 'pending' || ((o.decision === 'accepted' || o.decision === 'edited') && !o.appliedAt));
  const anyApplied = ops.some((o) => o.appliedAt);
  if (open.length === 0) return anyApplied ? 'applied' : 'rejected';
  return anyApplied ? 'partial' : 'pending';
}

export async function refreshProposalStatus(tx: Tx, proposalId: string): Promise<ProposalStatus> {
  const ops = await tx
    .select({ decision: proposalOps.decision, appliedAt: proposalOps.appliedAt })
    .from(proposalOps)
    .where(eq(proposalOps.proposalId, proposalId));
  const status = deriveProposalStatus(ops);
  const [p] = await tx.update(proposals).set({ status, updatedAt: new Date() }).where(eq(proposals.id, proposalId)).returning();
  await tx
    .update(observations)
    .set({ status: status === 'applied' || status === 'rejected' ? 'resolved' : 'open' })
    .where(eq(observations.id, p!.observationId));
  return status;
}
