import { receiptVerdict, type Confidence, type LineKind, type ReceiptVerdict, type VerdictLine } from '@buttery/domain';
import type { IgnoreDraft, LotDraft } from './drafts';

type OpLike = { id: string; op: string; confidence: string; decision?: string | null; appliedAt?: Date | null; payload: unknown };
export type LineToCheck = { op_id: string; kind: 'item' | 'skipped'; raw_text: string; food_name: string | null; confidence: Confidence; rationale: string | null };

const isOpen = (o: OpLike) => !o.appliedAt && o.decision !== 'rejected';

/** Verdict over the lines still open; null when nothing is left to decide. */
export function verdictFor(
  ops: Array<OpLike & { rationale?: string | null }>,
  obs: { possibleDuplicateOf: string | null; reasoningFallback: boolean },
): { verdict: ReceiptVerdict | null; lines_to_check: LineToCheck[] } {
  const open = ops.filter(isOpen);
  if (!open.length) return { verdict: null, lines_to_check: [] };
  const lines: VerdictLine[] = open.map((o) =>
    o.op === 'ignore_line'
      ? { kind: 'ignored', line_kind: (o.payload as IgnoreDraft).line_kind as Exclude<LineKind, 'item'>, confidence: o.confidence as Confidence }
      : { kind: 'item', confidence: o.confidence as Confidence },
  );
  const verdict = receiptVerdict({ lines, possibleDuplicate: Boolean(obs.possibleDuplicateOf), fallbackUsed: obs.reasoningFallback });
  const lines_to_check = open
    .filter((o) => o.confidence !== 'high')
    .map((o) => ({
      op_id: o.id,
      kind: o.op === 'ignore_line' ? ('skipped' as const) : ('item' as const),
      raw_text: (o.payload as LotDraft).line.raw_text,
      food_name: o.op === 'ignore_line' ? null : (o.payload as LotDraft).food_name,
      confidence: o.confidence as Confidence,
      rationale: o.rationale ?? null,
    }));
  return { verdict, lines_to_check };
}

export function verdictNext(v: ReceiptVerdict | null, reviewUrl: string, toCheck: number): string[] {
  if (!v) return [];
  if (v.verdict === 'safe_to_apply') {
    return [
      `${v.reasons[0]}. Ask the user for a quick yes in chat (e.g. "Add all ${v.counts.items}?"). On yes, call resolve_proposal with accept_remaining: true, apply: true. Offer the review link only if they want to look: ${reviewUrl}`,
    ];
  }
  if (v.verdict === 'quick_check') {
    return [
      `${toCheck} line(s) are worth a glance (lines_to_check). Read them to the user as "receipt text → item" and ask whether to add everything; on yes call resolve_proposal with accept_remaining: true, apply: true. If they want to change anything, share the review link: ${reviewUrl}`,
    ];
  }
  return [`Needs a proper review (${v.reasons.join('; ')}). Give the user the review link: ${reviewUrl}`];
}
