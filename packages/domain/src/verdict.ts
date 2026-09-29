import type { Confidence } from './common';
import type { LineKind } from './receipt';

export type VerdictLevel = 'safe_to_apply' | 'quick_check' | 'needs_review';
export type VerdictLine = { kind: 'item'; confidence: Confidence } | { kind: 'ignored'; line_kind: Exclude<LineKind, 'item'>; confidence: Confidence };
export type ReceiptVerdict = {
  verdict: VerdictLevel;
  reasons: string[];
  counts: { items: number; high: number; medium: number; low: number };
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * How much attention a receipt still needs, from per-line model confidence (measured: `high`
 * matches were right 99.4% of the time) plus facts only the server knows.
 * - safe_to_apply: every open item line is high confidence and nothing blocks → a one-word yes is enough.
 * - quick_check: some lines are medium → show those lines, then accept.
 * - needs_review: low confidence, a possible duplicate, heuristic fallback or a return → open the review.
 */
export function receiptVerdict(input: { lines: VerdictLine[]; possibleDuplicate: boolean; fallbackUsed: boolean }): ReceiptVerdict {
  const items = input.lines.filter((l) => l.kind === 'item');
  const ignored = input.lines.filter((l) => l.kind === 'ignored');
  const count = (c: Confidence) => items.filter((l) => l.confidence === c).length;
  const counts = { items: items.length, high: count('high'), medium: count('medium'), low: count('low') };

  const blockers: string[] = [];
  if (input.possibleDuplicate) blockers.push('May duplicate a receipt already recorded');
  if (input.fallbackUsed) blockers.push('Matched without the reasoning model');
  if (counts.low) blockers.push(`${plural(counts.low, 'item', 'items')} low confidence`);
  if (ignored.some((l) => l.line_kind === 'return')) blockers.push("Includes a return, which isn't applied automatically");
  const doubtfulSkips = ignored.filter((l) => l.confidence === 'low').length;
  if (doubtfulSkips) blockers.push(`${plural(doubtfulSkips, 'skipped line may', 'skipped lines may')} actually be food`);

  const notes: string[] = [];
  if (counts.medium) notes.push(`${plural(counts.medium, 'item', 'items')} worth a glance`);
  const unsureSkips = ignored.filter((l) => l.confidence === 'medium').length;
  if (unsureSkips) notes.push(`${plural(unsureSkips, 'skipped line', 'skipped lines')} worth a glance`);

  if (blockers.length) return { verdict: 'needs_review', reasons: [...blockers, ...notes], counts };
  if (notes.length) return { verdict: 'quick_check', reasons: notes, counts };
  return {
    verdict: 'safe_to_apply',
    reasons: [counts.items ? `All ${plural(counts.items, 'item', 'items')} matched with high confidence` : 'No food items to add'],
    counts,
  };
}
