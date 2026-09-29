import { z } from 'zod';
import {
  computeEffectiveExpiry,
  IsoDateSchema,
  PerishabilitySchema,
  QuantitySchema,
  type Expiry,
  type IsoDate,
  type LineKind,
  type LotState,
  type Package,
  type Perishability,
  type Quantity,
  type ShelfLifeMap,
} from '@buttery/domain';
import type { FoodRow } from '../db/schema';
import { AppError } from '../errors';

export type LineSnapshot = { line_id: string; raw_text: string; detail?: string; quantity?: number; unit?: string; price_cents?: number };

export type LotDraft = {
  line: LineSnapshot;
  food_id: string | null;
  food_name: string;
  new_food: { name: string; category: string | null; perishability: Perishability; shelf_life: ShelfLifeMap } | null;
  location: string;
  state: LotState;
  quantity: Quantity;
  package: Package | null;
  acquired_on: IsoDate;
  printed_expiry_on: IsoDate | null;
  notes: string | null;
};

export type IgnoreDraft = { line: LineSnapshot; line_kind: Exclude<LineKind, 'item'>; reason: string };

export const LotDraftEditSchema = z
  .object({
    food_id: z.uuid().optional().describe('Switch this line to an existing food'),
    new_food: z
      .object({ name: z.string().min(1).max(100), category: z.string().max(40).optional(), perishability: PerishabilitySchema.optional() })
      .optional()
      .describe('Treat this line as a new food with this name'),
    quantity: QuantitySchema.optional(),
    location: z.string().min(1).max(40).optional(),
    expires_on: IsoDateSchema.nullable().optional().describe('Date printed on the package; null clears it'),
    notes: z.string().max(500).nullable().optional(),
  })
  .strict();
export type LotDraftEdit = z.infer<typeof LotDraftEditSchema>;

export function defaultLocationFor(perishability: Perishability): string {
  return perishability === 'perishable' ? 'fridge' : 'pantry';
}

export function applyDraftEdits(draft: LotDraft, e: LotDraftEdit, foodsById: Map<string, FoodRow>): LotDraft {
  const next: LotDraft = { ...draft };
  if (e.food_id) {
    const f = foodsById.get(e.food_id);
    if (!f) throw new AppError('invalid_input', 'Unknown food_id for this household', 422);
    next.food_id = f.id;
    next.food_name = f.name;
    next.new_food = null;
    if (!e.location && f.defaultLocation) next.location = f.defaultLocation;
  }
  if (e.new_food) {
    const base = next.new_food ?? { name: next.food_name, category: null, perishability: 'perishable' as Perishability, shelf_life: {} };
    next.food_id = null;
    next.new_food = {
      ...base,
      name: e.new_food.name,
      category: e.new_food.category ?? base.category,
      perishability: e.new_food.perishability ?? base.perishability,
    };
    next.food_name = next.new_food.name;
  }
  if (e.quantity) next.quantity = e.quantity;
  if (e.location) next.location = e.location;
  if (e.expires_on !== undefined) next.printed_expiry_on = e.expires_on;
  if (e.notes !== undefined) next.notes = e.notes;
  return next;
}

export function previewExpiry(d: LotDraft, food?: FoodRow): Expiry | null {
  return computeEffectiveExpiry({
    perishability: food?.perishability ?? d.new_food?.perishability ?? 'perishable',
    state: d.state,
    anchors: { sealed: d.acquired_on },
    printedExpiryOn: d.printed_expiry_on,
    shelfLife: food?.shelfLife ?? d.new_food?.shelf_life ?? {},
  });
}

type CountableOp = { op: string; targetFoodId: string | null; confidence: string; decision?: string; appliedAt?: Date | null; payload: unknown };

export function countOps(ops: CountableOp[]) {
  const lotOps = ops.filter((o) => o.op === 'add_lot');
  const newNames = new Set(lotOps.filter((o) => !o.targetFoodId).map((o) => (o.payload as LotDraft).food_name.toLowerCase()));
  return {
    lines: ops.length,
    items: lotOps.length,
    matched: lotOps.filter((o) => o.targetFoodId).length,
    new_foods: newNames.size,
    ignored: ops.filter((o) => o.op === 'ignore_line').length,
    low_confidence: ops.filter((o) => o.confidence === 'low').length,
    pending: ops.filter((o) => (o.decision ?? 'pending') === 'pending' && !o.appliedAt).length,
    applied: ops.filter((o) => o.appliedAt).length,
  };
}
