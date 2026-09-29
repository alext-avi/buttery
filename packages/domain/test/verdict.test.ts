import { describe, expect, it } from 'vitest';
import { receiptVerdict, type VerdictLine } from '../src';

const item = (confidence: 'high' | 'medium' | 'low'): VerdictLine => ({ kind: 'item', confidence });
const ignored = (line_kind: 'coupon' | 'non_food' | 'return', confidence: 'high' | 'medium' | 'low' = 'high'): VerdictLine => ({ kind: 'ignored', line_kind, confidence });
const verdict = (lines: VerdictLine[], extra: { possibleDuplicate?: boolean; fallbackUsed?: boolean } = {}) =>
  receiptVerdict({ lines, possibleDuplicate: false, fallbackUsed: false, ...extra });

describe('receiptVerdict', () => {
  it('is safe to apply when every item line is high confidence', () => {
    expect(verdict([item('high'), item('high'), ignored('coupon')])).toEqual({
      verdict: 'safe_to_apply',
      reasons: ['All 2 items matched with high confidence'],
      counts: { items: 2, high: 2, medium: 0, low: 0 },
    });
  });

  it('asks for a quick check when some lines are medium', () => {
    const v = verdict([item('high'), item('medium')]);
    expect(v.verdict).toBe('quick_check');
    expect(v.reasons).toEqual(['1 item worth a glance']);
  });

  it('treats a skipped line of uncertain kind as worth a glance', () => {
    expect(verdict([item('high'), ignored('non_food', 'medium')]).verdict).toBe('quick_check');
  });

  it('needs review for low confidence, duplicates, fallback and returns', () => {
    expect(verdict([item('high'), item('low')])).toMatchObject({ verdict: 'needs_review', reasons: ['1 item low confidence'] });
    expect(verdict([item('high')], { possibleDuplicate: true }).reasons).toContain('May duplicate a receipt already recorded');
    expect(verdict([item('high')], { fallbackUsed: true }).reasons).toContain('Matched without the reasoning model');
    expect(verdict([item('high'), ignored('return')]).reasons).toContain("Includes a return, which isn't applied automatically");
    expect(verdict([item('high'), ignored('coupon', 'low')]).reasons).toContain('1 skipped line may actually be food');
  });

  it('lists blockers before softer notes', () => {
    const v = verdict([item('medium'), item('low')], { possibleDuplicate: true });
    expect(v.verdict).toBe('needs_review');
    expect(v.reasons).toEqual(['May duplicate a receipt already recorded', '1 item low confidence', '1 item worth a glance']);
  });

  it('is safe when there is nothing to add', () => {
    expect(verdict([ignored('coupon')])).toMatchObject({ verdict: 'safe_to_apply', reasons: ['No food items to add'] });
  });
});
