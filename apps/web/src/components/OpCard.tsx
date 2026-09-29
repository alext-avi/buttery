import { useState, type FormEvent } from 'react';
import { amount, money } from '../format';
import type { Edits, OpView, Quantity } from '../types';
import { ConfidenceBadge, ExpiryBadge } from './Badges';

/** Each button saves straight away: add this line, skip it, save an edit and add it, or undo it. */
export type LineActions = {
  add: (edits?: Edits) => void;
  skip: () => void;
  undo: (changeSetId: string) => void;
  /** Saving, or waiting on the "different purchase" confirmation. */
  disabled: boolean;
};

const LOCATIONS = ['fridge', 'freezer', 'pantry', 'counter'];
const UNITS = ['count', 'g', 'kg', 'oz', 'lb', 'ml', 'l', 'fl_oz', 'cup', 'pt', 'qt', 'gal'];

export function OpCard({ op, today, actions }: { op: OpView; today: string; actions?: LineActions }) {
  const [editing, setEditing] = useState(false);

  if (op.op === 'ignore_line' || !op.draft) {
    return (
      <li data-testid="op">
        <div className="raw">
          {op.line.raw_text}
          {op.line.price_cents !== undefined && <span>{money(op.line.price_cents)}</span>}
        </div>
        <div className="meta">
          {op.reason} {!op.applied && <ConfidenceBadge value={op.confidence} />}
        </div>
      </li>
    );
  }

  const d = op.draft;
  const skipped = op.decision === 'rejected' && !op.applied;

  return (
    <li className={skipped ? 'skipped' : undefined} data-testid="op">
      <div className="raw">
        {op.line.raw_text}
        {op.line.price_cents !== undefined && <span>{money(op.line.price_cents)}</span>}
      </div>
      <div className="title-row">
        <strong className="name">{d.food_name}</strong>
        {d.is_new_food && <span className="badge new">New item</span>}
        {!op.applied && !skipped && <ConfidenceBadge value={op.confidence} />}
        {op.decision === 'edited' && <span className="badge">Edited</span>}
        {op.applied && <span className="badge ok">Added</span>}
        {skipped && <span className="badge">Skipped</span>}
      </div>
      <div className="meta">
        {amount(d.quantity_text)} · {d.location} · <ExpiryBadge expires={d.expires_preview} today={today} />
      </div>
      {op.confidence === 'low' && op.rationale && !op.applied && <div className="hint">{op.rationale}</div>}

      {actions && !editing && (
        <div className="actions">
          {op.applied ? (
            op.change_set_id && (
              <button type="button" onClick={() => actions.undo(op.change_set_id!)} disabled={actions.disabled}>
                Undo
              </button>
            )
          ) : (
            <>
              <button type="button" className="primary" onClick={() => actions.add()} disabled={actions.disabled}>
                Add
              </button>
              {!skipped && (
                <button type="button" onClick={actions.skip} disabled={actions.disabled}>
                  Skip
                </button>
              )}
              <button type="button" onClick={() => setEditing(true)} disabled={actions.disabled}>
                Edit
              </button>
            </>
          )}
        </div>
      )}
      {actions && editing && (
        <EditForm
          op={op}
          initial={{}}
          onCancel={() => setEditing(false)}
          onSave={(e) => {
            actions.add(e);
            setEditing(false);
          }}
        />
      )}
    </li>
  );
}

function EditForm({ op, initial, onSave, onCancel }: { op: OpView; initial: Edits; onSave: (e: Edits) => void; onCancel: () => void }) {
  const d = op.draft!;
  const q = initial.quantity ?? d.quantity;
  const [foodId, setFoodId] = useState(initial.food_id ?? '');
  const [name, setName] = useState(initial.new_food?.name ?? d.food_name);
  const [amount, setAmount] = useState(q.amount?.toString() ?? '');
  const [unit, setUnit] = useState(q.unit ?? 'count');
  const [approx, setApprox] = useState(q.kind === 'approx');
  const [location, setLocation] = useState(initial.location ?? d.location);
  const [expires, setExpires] = useState(initial.expires_on ?? d.printed_expiry_on ?? '');

  function save(ev: FormEvent) {
    ev.preventDefault();
    const e: Edits = {};
    if (foodId) e.food_id = foodId;
    else if (name.trim() && name.trim() !== d.food_name) e.new_food = { name: name.trim() };
    const quantity: Quantity = amount === '' ? { kind: 'unknown' } : { kind: approx ? 'approx' : 'exact', amount: Number(amount), unit };
    if (quantity.kind !== d.quantity.kind || quantity.amount !== d.quantity.amount || quantity.unit !== d.quantity.unit) {
      e.quantity = quantity;
    }
    if (location !== d.location) e.location = location;
    if (expires !== (d.printed_expiry_on ?? '')) e.expires_on = expires || null;
    onSave(e);
  }

  return (
    <form className="edit" onSubmit={save}>
      {op.candidates.length > 0 && (
        <label>
          Same as an existing item
          <select value={foodId} onChange={(e) => setFoodId(e.target.value)}>
            <option value="">No, keep as below</option>
            {op.candidates.map((c) => (
              <option key={c.food_id} value={c.food_id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {!foodId && (
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      )}
      <div className="row">
        <label>
          Amount
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="unknown" />
        </label>
        <label>
          Unit
          <select value={unit} onChange={(e) => setUnit(e.target.value)}>
            {UNITS.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={approx} onChange={(e) => setApprox(e.target.checked)} /> Approximate
      </label>
      <label>
        Location
        <select value={location} onChange={(e) => setLocation(e.target.value)}>
          {[...new Set([...LOCATIONS, d.location])].map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </label>
      <label>
        Date printed on package (optional)
        <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
      </label>
      <div className="actions">
        <button type="submit" className="primary">
          Save and add
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
