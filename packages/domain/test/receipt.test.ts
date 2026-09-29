import { describe, expect, it } from 'vitest';
import { hashJson, receiptFingerprint, receiptNearKey, ReceiptPayloadSchema, withLineIds } from '../src';

const base = {
  store: 'PANTRY CLUB',
  purchased_at: '2026-09-28T18:42',
  receipt_number: 'PC-004218',
  total_cents: 4694,
  lines: [{ raw_text: 'WHOLE MILK 1 GAL' }],
};

describe('receipt identity', () => {
  it('hashes JSON independent of key order', () => {
    expect(hashJson({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(hashJson({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });

  it('fingerprints by store + receipt number + date when a number is present', () => {
    const recapture = { ...base, store: 'Pantry Club', purchased_at: '2026-09-28T18:43', total_cents: 4649 };
    expect(receiptFingerprint(recapture)).toBe(receiptFingerprint(base));
  });

  it('falls back to store + minute + total without a number', () => {
    const a = { ...base, receipt_number: undefined };
    expect(receiptFingerprint(a)).toBe(receiptFingerprint({ ...a, lines: [{ raw_text: 'different' }] }));
    expect(receiptFingerprint(a)).not.toBe(receiptFingerprint({ ...a, total_cents: 100 }));
  });

  it('near key ignores the receipt number so a mixed pair is still flagged', () => {
    expect(receiptNearKey({ ...base, receipt_number: undefined })).toBe(receiptNearKey(base));
    expect(receiptNearKey({ ...base, total_cents: undefined })).toBeNull();
  });

  it('assigns stable line ids', () => {
    const p = withLineIds(ReceiptPayloadSchema.parse({ ...base, lines: [{ raw_text: 'A' }, { raw_text: 'B', line_id: 'x' }, { raw_text: 'C' }] }));
    expect(p.lines.map((l) => l.line_id)).toEqual(['L1', 'x', 'L3']);
  });

  it('validates the purchase timestamp format', () => {
    expect(() => ReceiptPayloadSchema.parse({ ...base, purchased_at: 'yesterday' })).toThrow();
  });
});
