import { z } from 'zod';
import { ConfidenceSchema, IsoDateSchema, LotStateSchema, type IsoDate, type LotState, type Perishability } from './common';
import { addDays, daysBetween, formatShortDate } from './dates';

export const ShelfLifeEntrySchema = z.object({
  days: z.number().int().nonnegative().nullable(),
  confidence: ConfidenceSchema,
  source: z.enum(['default_rule', 'model_estimate', 'agent_hint', 'user']),
  model: z.string().optional(),
  reasoning_call_id: z.string().optional(),
});
export type ShelfLifeEntry = z.infer<typeof ShelfLifeEntrySchema>;

export const ShelfLifeMapSchema = z.partialRecord(LotStateSchema, ShelfLifeEntrySchema);
export type ShelfLifeMap = Partial<Record<LotState, ShelfLifeEntry>>;

export const ExpirySchema = z.object({
  on: IsoDateSchema,
  kind: z.enum(['printed', 'estimated']),
  confidence: ConfidenceSchema,
  basis: z.string(),
});
export type Expiry = z.infer<typeof ExpirySchema>;

const VERB: Record<LotState, string> = { sealed: 'bought', opened: 'opened', frozen: 'frozen', thawed: 'thawed', prepared: 'cooked' };

export type ExpiryInput = {
  perishability: Perishability;
  state: LotState;
  anchors: Partial<Record<LotState, IsoDate>>;
  printedExpiryOn?: IsoDate | null;
  shelfLife: ShelfLifeMap;
};

export function computeEffectiveExpiry(i: ExpiryInput): Expiry | null {
  if (i.state === 'sealed' && i.printedExpiryOn) {
    return { on: i.printedExpiryOn, kind: 'printed', confidence: 'high', basis: 'printed on package' };
  }
  if (i.perishability === 'shelf_stable' && i.state === 'sealed') return null;
  const entry = i.shelfLife[i.state];
  const anchor = i.anchors[i.state];
  if (!entry || entry.days === null || !anchor) return null;
  const source = entry.model ? `${entry.source}, ${entry.model}` : entry.source;
  return {
    on: addDays(anchor, entry.days),
    kind: 'estimated',
    confidence: entry.confidence,
    basis: `${VERB[i.state]} ${anchor} + ${entry.days}d (${source}, ${entry.confidence})`,
  };
}

export type Urgency = 'expired' | 'urgent' | 'soon' | 'later';
export const DEFAULT_WINDOWS = { urgentDays: 2, soonDays: 7 };

export function urgencyOf(expiry: Expiry | null | undefined, today: IsoDate, w = DEFAULT_WINDOWS): Urgency | null {
  if (!expiry) return null;
  const d = daysBetween(today, expiry.on);
  if (d < 0) return 'expired';
  if (d <= w.urgentDays) return 'urgent';
  if (d <= w.soonDays) return 'soon';
  return 'later';
}

export function describeExpiry(expiry: Expiry | null | undefined, today: IsoDate): string {
  if (!expiry) return 'no expiry tracked';
  const d = daysBetween(today, expiry.on);
  const when = d < 0 ? `${-d}d ago` : formatShortDate(expiry.on, today);
  if (expiry.kind === 'printed') return `${d < 0 ? 'expired' : 'exp'} ${when}`;
  return `${d < 0 ? 'est. expired' : 'est.'} ${when} · ${expiry.confidence}`;
}
