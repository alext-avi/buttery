import { readFileSync } from 'node:fs';
import type { ReceiptPayload } from '@buttery/domain';

type Row = {
  raw: string;
  detail?: string;
  quantity?: number;
  unit?: string;
  amount: number;
  kind: string;
  package_count?: number;
  package_size?: { quantity: number; unit: string };
};
type Receipt = { merchant: string; transaction_id: string; purchased_at_local: string; total: number; rows: Row[] };

const FIXTURE = new URL('../../../../tests/fixtures/food-images/sources/expected-text.json', import.meta.url);
const data = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { receipts: Record<'warehouse' | 'mixed', Receipt> };
const KIND = { food_purchase: 'item', discount: 'coupon', non_food_purchase: 'non_food', return: 'return' } as const;

export function fixtureReceipt(name: 'warehouse' | 'mixed'): ReceiptPayload {
  const r = data.receipts[name];
  return {
    store: r.merchant,
    purchased_at: r.purchased_at_local.slice(0, 16),
    receipt_number: r.transaction_id,
    total_cents: Math.round(r.total * 100),
    lines: r.rows.map((row) => ({
      raw_text: row.raw,
      ...(row.detail ? { detail: row.detail } : {}),
      ...(row.quantity !== undefined ? { quantity: row.quantity } : {}),
      ...(row.unit ? { unit: row.unit } : {}),
      price_cents: Math.round(row.amount * 100),
      line_kind: KIND[row.kind as keyof typeof KIND],
      ...(row.package_size
        ? { hint: { package: { ...(row.package_count ? { count: row.package_count } : {}), size: row.package_size.quantity, unit: row.package_size.unit } } }
        : {}),
    })),
  };
}
