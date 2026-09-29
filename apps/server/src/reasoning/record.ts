import type { Tx } from '../db/client';
import { reasoningCalls } from '../db/schema';
import type { ReasoningResult } from './port';

export async function persistReasoningCall(tx: Tx, householdId: string, id: string, r: ReasoningResult<unknown>): Promise<void> {
  await tx.insert(reasoningCalls).values({
    id,
    householdId,
    function: r.call.function,
    provider: r.call.provider,
    model: r.call.model,
    path: r.path,
    inputHash: r.call.inputHash,
    input: r.call.input as object,
    output: r.call.output as object,
    valid: r.call.valid,
    violations: r.violations,
    latencyMs: Math.round(r.call.latencyMs),
    tokensIn: r.call.tokensIn,
    tokensOut: r.call.tokensOut,
    error: r.call.error,
  });
}
