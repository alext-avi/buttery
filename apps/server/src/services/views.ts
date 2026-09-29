import { describeExpiry, describeQuantity, urgencyOf, type Expiry, type IsoDate, type Package, type Quantity, type Urgency } from '@buttery/domain';
import type { FoodRow, LotRow } from '../db/schema';
import type { makeLinks } from './links';

export type LotView = {
  lot_id: string;
  food: { id: string; name: string; category: string | null; perishability: string };
  location: string;
  state: string;
  status: string;
  quantity: Quantity;
  package: Package | null;
  quantity_text: string;
  expires: Expiry | null;
  expiry_text: string;
  urgency: Urgency | null;
  acquired_on: string | null;
  last_evidence_at: string | null;
  evidence_age_days: number | null;
  links: { item: string };
};

export function toLotView(lot: LotRow, food: FoodRow, today: IsoDate, links: ReturnType<typeof makeLinks>, now: Date): LotView {
  return {
    lot_id: lot.id,
    food: { id: food.id, name: food.name, category: food.category, perishability: food.perishability },
    location: lot.location,
    state: lot.state,
    status: lot.status,
    quantity: lot.quantity,
    package: lot.package ?? null,
    quantity_text: describeQuantity(lot.quantity, lot.package),
    expires: lot.expires ?? null,
    expiry_text: describeExpiry(lot.expires, today),
    urgency: urgencyOf(lot.expires, today),
    acquired_on: lot.acquiredOn,
    last_evidence_at: lot.lastEvidenceAt?.toISOString() ?? null,
    evidence_age_days: lot.lastEvidenceAt ? Math.floor((now.getTime() - lot.lastEvidenceAt.getTime()) / 86_400_000) : null,
    links: { item: links.item(lot.id) },
  };
}

export type CompactLot = { lot_id: string; name: string; location: string; quantity_text: string; expiry_text: string; urgency: Urgency | null; link: string };

export function compactLot(v: LotView): CompactLot {
  return { lot_id: v.lot_id, name: v.food.name, location: v.location, quantity_text: v.quantity_text, expiry_text: v.expiry_text, urgency: v.urgency, link: v.links.item };
}
