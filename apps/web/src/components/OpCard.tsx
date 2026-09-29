import { useState, type FormEvent } from 'react';
import { money } from '../format';
import type { Edits, OpView, Quantity } from '../types';
import { ConfidenceBadge, ExpiryBadge } from './Badges';

export type Choice = { action: 'accept' } | { action: 'reject' } | { action: 'edit'; edits: Edits };

const LOCATIONS = ['fridge', 'freezer', 'pantry', 'counter'];
const UNITS = ['count', 'g', 'kg', 'oz', 'lb', 'ml', 'l', 'fl_oz', 'cup', 'pt', 'qt', 'gal'];

function describe(q: Quantity): string {
  if (q.kind === 'unknown' || q.amount === undefined) return 'unknown amount';
  return `${q.kind === 'approx' ? '~' : ''}${q.amount}${q.unit && q.unit !== 'count' ? ` ${q.unit}` : ''}`;
}

export function OpCard({ op, choice, onChange }: { op: OpView; choice: Choice; onChange?: (c: Choice) => void }) {
  const [editing, setEditing] = useState(false);

  if (op.op === 'ignore_line' || !op.draft) {
    return (
      <li className="card muted-card" data-testid="op">
        <div className="raw">
          {op.line.raw_text}
          {op.line.price_cents !== undefined && <span>{money(op.line.price_cents)}</span>}
        </div>
        <div className="meta">{op.reason}</div>
      </li>
    );
  }

  const d = op.draft;
  const edits = choice.action === 'edit' ? choice.edits : {};
  const name = edits.new_food?.name ?? op.candidates.find((c) => c.food_id === edits.food_id)?.name ?? d.food_name;
  const skipped = choice.action === 'reject';

  return (
    <li className={`card${skipped ? ' skipped' : ''}`} data-testid="op">
      <div className="raw">
        {op.line.raw_text}
        {op.line.price_cents !== undefined && <span>{money(op.line.price_cents)}</span>}
      </div>
      <div className="title-row">
        <strong>{name}</strong>
        {d.is_new_food && !edits.food_id && <span className="badge">New item</span>}
        {op.confidence !== 'high' && !op.applied && <ConfidenceBadge value={op.confidence} />}
        {choice.action === 'edit' && !op.applied && <span className="badge">Edited</span>}
        {op.applied && <span className="badge ok">Added</span>}
        {skipped && <span className="badge">Skipped</span>}
      </div>
      <div className="meta">
        {edits.quantity ? describe(edits.quantity) : d.quantity_text} · {edits.location ?? d.location} ·{' '}
        {edits.expires_on ? <span>exp {edits.expires_on}</span> : <ExpiryBadge text={d.expiry_text} kind={d.expires_preview?.kind} />}
      </div>
      {!edits.expires_on && d.expires_preview?.kind === 'estimated' && <div className="muted small">{d.expires_preview.basis}</div>}
      {op.confidence === 'low' && op.rationale && !op.applied && <div className="hint">{op.rationale}</div>}

      {onChange && !op.applied && !editing && (
        <div className="actions">
          <button type="button" className={skipped ? '' : 'selected'} aria-pressed={!skipped} onClick={() => onChange(choice.action === 'edit' ? choice : { action: 'accept' })}>
            Add
          </button>
          <button type="button" className={skipped ? 'selected' : ''} aria-pressed={skipped} onClick={() => onChange({ action: 'reject' })}>
            Skip
          </button>
          <button type="button" onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
      )}
      {onChange && editing && (
        <EditForm
          op={op}
          initial={edits}
          onCancel={() => setEditing(false)}
          onSave={(e) => {
            onChange({ action: 'edit', edits: e });
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
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
