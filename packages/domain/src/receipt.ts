import { z } from 'zod';
import { PackageInputSchema } from './quantity';
import { normalizeName } from './normalize';
import { sha256Hex } from './hash';

export const LineKindSchema = z.enum(['item', 'coupon', 'return', 'non_food']);
export type LineKind = z.infer<typeof LineKindSchema>;

export const ReceiptLineSchema = z.object({
  line_id: z.string().min(1).max(40).optional().describe('Optional; the server assigns L1, L2… if omitted'),
  raw_text: z.string().min(1).max(200).describe('The line exactly as printed, e.g. "GRK YOGURT 2X32 OZ"'),
  detail: z.string().max(200).optional().describe('Secondary printed text, e.g. "1.25 LB @ 0.64/LB"'),
  quantity: z.number().positive().optional().describe('Count or weight bought on this line (default 1)'),
  unit: z.string().max(20).optional().describe('Unit of quantity when weighed, e.g. "lb"'),
  unit_price_cents: z.number().int().optional(),
  price_cents: z.number().int().optional().describe('Line total in cents; negative for coupons and returns'),
  line_kind: LineKindSchema.optional().describe('item | coupon | return | non_food'),
  hint: z
    .object({
      food_name: z.string().max(100).optional(),
      package: PackageInputSchema.optional(),
      location_guess: z.string().max(40).optional(),
    })
    .optional()
    .describe('Optional hints; the server decides the canonical item'),
});
export type ReceiptLine = z.infer<typeof ReceiptLineSchema>;

export const ReceiptPayloadSchema = z.object({
  store: z.string().min(1).max(100),
  purchased_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/, 'local date/time like 2026-09-28T18:42')
    .describe('Local purchase date/time as printed'),
  receipt_number: z.string().max(60).optional().describe('Transaction/receipt number if printed'),
  total_cents: z.number().int().optional(),
  lines: z.array(ReceiptLineSchema).min(1).max(200).describe('Every printed line, in order'),
});
export type ReceiptPayload = z.infer<typeof ReceiptPayloadSchema>;
export type ReceiptPayloadWithIds = ReceiptPayload & { lines: Array<ReceiptLine & { line_id: string }> };

export function withLineIds(p: ReceiptPayload): ReceiptPayloadWithIds {
  const used = new Set(p.lines.map((l) => l.line_id).filter(Boolean));
  return {
    ...p,
    lines: p.lines.map((l, i) => {
      if (l.line_id) return l as ReceiptLine & { line_id: string };
      let id = `L${i + 1}`;
      while (used.has(id)) id = `${id}_`;
      used.add(id);
      return { ...l, line_id: id };
    }),
  };
}

type Identity = Pick<ReceiptPayload, 'store' | 'purchased_at' | 'receipt_number' | 'total_cents'>;

export function receiptFingerprint<T extends Identity>(r: T): string {
  const store = normalizeName(r.store);
  if (r.receipt_number) return sha256Hex(['rn', store, normalizeName(r.receipt_number), r.purchased_at.slice(0, 10)].join('|'));
  return sha256Hex(['ts', store, r.purchased_at.slice(0, 16), String(r.total_cents ?? '')].join('|'));
}

export function receiptNearKey<T extends Identity>(r: T): string | null {
  if (r.total_cents === undefined) return null;
  return sha256Hex(['near', normalizeName(r.store), r.purchased_at.slice(0, 10), String(r.total_cents)].join('|'));
}
