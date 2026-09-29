import type { IsoDate, LotState, Perishability } from './common';
import { computeEffectiveExpiry, type Expiry, type ShelfLifeMap } from './expiry';
import type { Package, Quantity, Unit } from './quantity';

export const ACTIVITY_KINDS = ['bought', 'used', 'finished', 'discarded', 'froze', 'thawed', 'opened', 'moved'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export type AmountChange = { fraction: number } | { quantity: Quantity };

export type LotFacts = {
  state: LotState;
  location: string;
  quantity: Quantity;
  package: Package | null;
  status: 'active' | 'depleted' | 'discarded' | 'voided';
  acquiredOn: IsoDate | null;
  openedOn: IsoDate | null;
  frozenOn: IsoDate | null;
  thawedOn: IsoDate | null;
  printedExpiryOn: IsoDate | null;
};

// Base units: grams for mass, millilitres for volume.
const MASS: Partial<Record<Unit, number>> = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 };
const VOLUME: Partial<Record<Unit, number>> = { ml: 1, l: 1000, fl_oz: 29.5735295625, cup: 236.5882365, pt: 473.176473, qt: 946.352946, gal: 3785.411784 };
const dimension = (u: Unit | undefined) => (u && MASS[u] ? 'mass' : u && VOLUME[u] ? 'volume' : 'count');
const factor = (u: Unit) => MASS[u] ?? VOLUME[u] ?? 1;
const EPS = 1e-9;
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Remaining quantity after using part of a lot. Never guesses across dimensions. */
export function consumeQuantity(q: Quantity, pkg: Package | null, change: AmountChange): { quantity: Quantity; exhausted: boolean; note?: string } {
  if (q.kind === 'unknown' || q.amount === undefined) {
    return { quantity: { kind: 'unknown' }, exhausted: false, note: 'The amount was already unknown.' };
  }
  if ('fraction' in change) {
    const left = round(q.amount * (1 - change.fraction));
    return { quantity: { kind: change.fraction >= 1 ? q.kind : 'approx', amount: Math.max(left, 0), ...(q.unit ? { unit: q.unit } : {}) }, exhausted: left <= EPS };
  }
  const used = change.quantity;
  if (used.kind === 'unknown' || used.amount === undefined) {
    return { quantity: { ...q, kind: 'approx' }, exhausted: false, note: 'The amount used was not given, so the rest is marked approximate.' };
  }
  const lotUnit = q.unit ?? 'count';
  const usedUnit = used.unit ?? 'count';
  const exact = q.kind === 'exact' && used.kind === 'exact';
  if (lotUnit === 'count' && usedUnit === 'count') {
    const left = round(q.amount - used.amount);
    return { quantity: { kind: exact ? 'exact' : 'approx', amount: Math.max(left, 0), unit: 'count' }, exhausted: left <= EPS };
  }
  // Express the lot in a measurable unit: its own unit, or its containers × package size.
  const lotMeasure = lotUnit !== 'count' ? { amount: q.amount, unit: lotUnit } : pkg?.size && pkg.unit ? { amount: q.amount * pkg.size, unit: pkg.unit } : null;
  if (!lotMeasure || dimension(lotMeasure.unit) === 'count' || dimension(lotMeasure.unit) !== dimension(usedUnit)) {
    return { quantity: { kind: 'unknown' }, exhausted: false, note: "Buttery couldn't compare those units, so the amount left is unknown." };
  }
  const leftBase = lotMeasure.amount * factor(lotMeasure.unit) - used.amount * factor(usedUnit);
  if (leftBase <= EPS) return { quantity: { kind: exact ? 'exact' : 'approx', amount: 0, unit: lotUnit }, exhausted: true };
  if (lotUnit !== 'count') {
    return { quantity: { kind: exact ? 'exact' : 'approx', amount: round(leftBase / factor(lotUnit)), unit: lotUnit }, exhausted: false };
  }
  const containers = round(leftBase / factor(pkg!.unit!) / pkg!.size!);
  const whole = Math.abs(containers - Math.round(containers)) < 1e-6;
  return { quantity: { kind: exact && whole ? 'exact' : 'approx', amount: whole ? Math.round(containers) : containers, unit: 'count' }, exhausted: false };
}

export type ActivityInput = { kind: Exclude<ActivityKind, 'bought'>; amount?: AmountChange; toLocation?: string };

const NEW_STATE: Partial<Record<ActivityInput['kind'], LotState>> = { froze: 'frozen', thawed: 'thawed', opened: 'opened' };
const DEFAULT_PLACE: Partial<Record<ActivityInput['kind'], string>> = { froze: 'freezer', thawed: 'fridge' };

/** Transitions that make no sense (or would silently reset an expiry clock) are refused, not applied. */
function refusal(lot: LotFacts, act: ActivityInput): string | null {
  if (act.kind === 'thawed' && lot.state !== 'frozen') return "It isn't frozen, so it can't be thawed.";
  if (act.kind === 'froze' && lot.state === 'frozen') return "It's already frozen.";
  if (act.kind === 'opened' && (lot.state === 'opened' || lot.state === 'thawed' || lot.state === 'prepared')) return "It's already opened.";
  if (act.kind === 'moved' && !act.toLocation) return 'Where should it go? Give a to_location.';
  if (act.kind === 'moved' && act.toLocation === lot.location) return `It's already in the ${lot.location}.`;
  return null;
}

function currentExpiry(lot: LotFacts, food: { perishability: Perishability; shelfLife: ShelfLifeMap }): Expiry | null {
  return computeEffectiveExpiry({
    perishability: food.perishability,
    state: lot.state,
    anchors: { sealed: lot.acquiredOn ?? undefined, opened: lot.openedOn ?? undefined, frozen: lot.frozenOn ?? undefined, thawed: lot.thawedOn ?? undefined },
    printedExpiryOn: lot.printedExpiryOn,
    shelfLife: food.shelfLife,
  });
}

/** The next state of a lot after an activity, with its expiry recomputed from the new anchors. */
export function applyActivity(
  lot: LotFacts,
  act: ActivityInput,
  food: { perishability: Perishability; shelfLife: ShelfLifeMap },
  today: IsoDate,
): { lot: LotFacts & { expires: Expiry | null }; needsShelfLife: LotState | null; notes: string[]; refused: string | null } {
  const refused = refusal(lot, act);
  if (refused) return { lot: { ...lot, expires: currentExpiry(lot, food) }, needsShelfLife: null, notes: [], refused };
  const next: LotFacts = { ...lot };
  const notes: string[] = [];
  switch (act.kind) {
    case 'used': {
      const r = consumeQuantity(lot.quantity, lot.package, act.amount ?? { quantity: { kind: 'unknown' } });
      next.quantity = r.quantity;
      if (r.exhausted) next.status = 'depleted';
      if (r.note) notes.push(r.note);
      break;
    }
    case 'finished':
      next.status = 'depleted';
      next.quantity = { kind: 'exact', amount: 0, ...(lot.quantity.unit ? { unit: lot.quantity.unit } : {}) };
      break;
    case 'discarded':
      next.status = 'discarded';
      break;
    case 'froze':
      next.state = 'frozen';
      next.frozenOn = today;
      break;
    case 'thawed':
      next.state = 'thawed';
      next.thawedOn = today;
      break;
    case 'opened':
      next.state = 'opened';
      next.openedOn = today;
      break;
    case 'moved':
      break;
  }
  if (act.toLocation) next.location = act.toLocation;
  else if (DEFAULT_PLACE[act.kind]) next.location = DEFAULT_PLACE[act.kind]!;

  const newState = NEW_STATE[act.kind];
  const needsShelfLife = newState && !food.shelfLife[newState] ? newState : null;
  const expires = computeEffectiveExpiry({
    perishability: food.perishability,
    state: next.state,
    anchors: {
      sealed: next.acquiredOn ?? undefined,
      opened: next.openedOn ?? undefined,
      frozen: next.frozenOn ?? undefined,
      thawed: next.thawedOn ?? undefined,
    },
    printedExpiryOn: next.printedExpiryOn,
    shelfLife: food.shelfLife,
  });
  return { lot: { ...next, expires }, needsShelfLife, notes, refused: null };
}

/** Spec lot-selection rule: the lot expiring first, then the oldest; unknown dates last. */
export function pickLot<L extends { expires: { on: string } | null; acquiredOn: string | null }>(lots: L[]): L | undefined {
  const key = (v: string | null | undefined) => v ?? '9999-12-31';
  return [...lots].sort((a, b) => key(a.expires?.on).localeCompare(key(b.expires?.on)) || key(a.acquiredOn).localeCompare(key(b.acquiredOn)))[0];
}
