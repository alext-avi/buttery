export type Confidence = 'high' | 'medium' | 'low';
export type Urgency = 'expired' | 'urgent' | 'soon' | 'later';
export type Quantity = { kind: 'exact' | 'approx' | 'unknown'; amount?: number; unit?: string };
export type Expiry = { on: string; kind: 'printed' | 'estimated'; confidence: Confidence; basis: string };

export type OpView = {
  op_id: string;
  seq: number;
  op: 'add_lot' | 'ignore_line';
  decision: 'pending' | 'accepted' | 'edited' | 'rejected' | 'conflict';
  applied: boolean;
  confidence: Confidence;
  rationale: string | null;
  line: { line_id: string; raw_text: string; detail?: string; quantity?: number; unit?: string; price_cents?: number };
  line_kind?: string;
  reason?: string;
  candidates: Array<{ food_id: string; name: string }>;
  draft: {
    food_id: string | null;
    food_name: string;
    is_new_food: boolean;
    category: string | null;
    perishability: string;
    location: string;
    quantity: Quantity;
    quantity_text: string;
    printed_expiry_on: string | null;
    expires_preview: Expiry | null;
    expiry_text: string;
  } | null;
};

export type ProposalView = {
  proposal: { id: string; status: string; created_at: string };
  observation: {
    id: string;
    kind: string;
    store: string | null;
    purchased_at: string | null;
    recorded_at: string;
    recorded_by: string | null;
    via: string | null;
    possible_duplicate_of: { observation_id: string; review_url: string | null } | null;
    uncertainties: string[];
  };
  ops: OpView[];
  counts: { lines: number; items: number; pending: number; applied: number; low_confidence: number };
  verdict: Verdict | null;
  links: { review: string; inventory: string };
};

export type Verdict = {
  verdict: 'safe_to_apply' | 'quick_check' | 'needs_review';
  reasons: string[];
  counts: { items: number; high: number; medium: number; low: number };
};

export type ResolveResponse = ProposalView & { applied_change_set_id: string | null; created_lot_ids: string[]; notes: string[] };

export type Edits = {
  food_id?: string;
  new_food?: { name: string };
  quantity?: Quantity;
  location?: string;
  expires_on?: string | null;
};
export type Decision = { op_id: string; action: 'accept' | 'reject' } | { op_id: string; action: 'edit'; edits: Edits };

export type LotView = {
  lot_id: string;
  food: { id: string; name: string; category: string | null; perishability: 'shelf_stable' | 'perishable' };
  location: string;
  state: string;
  status: string;
  quantity_text: string;
  expires: Expiry | null;
  expiry_text: string;
  urgency: Urgency | null;
  acquired_on: string | null;
  evidence_age_days: number | null;
};

export type InventoryResponse = {
  today: string;
  use_soon: { expired: LotView[]; urgent: LotView[]; soon: LotView[] };
  by_location: Record<string, LotView[]>;
  locations: string[];
};

export type ItemResponse = {
  lot: LotView;
  food: { id: string; name: string; aliases: string[]; perishability: string };
  evidence: Array<{ observation_id: string; kind: string; summary: string; line: string | null; price_cents: number | null; review_url: string | null }>;
  history: Array<{ change_set_id: string; label: string; op: string; at: string; by: string | null; via: string | null; undone: boolean; is_undo: boolean }>;
  reasoning: Array<{ call_id: string; function: string; provider: string; model: string | null; path: string }>;
};

export type UndoResponse = { reverted_change_set_id: string; label: string; lots_voided: number };

export type Me = {
  user: { id: string; email: string | null; display_name: string | null };
  household: { id: string; name: string; timezone: string };
  connection: { id: string; client_name: string };
};
export type TokenRow = { connection_id: string; client_name: string; token_prefix: string | null; created_at: string; last_used_at: string | null };
export type NewToken = { token: string; connection_id: string; client_name: string; mcp_url: string };
