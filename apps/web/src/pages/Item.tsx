import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError, newKey, type ItemActivityKind } from '../api';
import { ExpiryBadge } from '../components/Badges';
import { ErrorBox } from '../components/ErrorBox';
import { ago, amount, cap, dateOnly, expiryNote, money, titleCase, when } from '../format';
import { useLoad } from '../useLoad';

const OP_LABEL: Record<string, string> = { add_lot: 'Added', void_lot: 'Removed', restore_lot: 'Restored' };
const PLACES = ['fridge', 'freezer', 'pantry', 'counter'];
const DONE: Record<ItemActivityKind, (to?: string) => string> = {
  used: () => 'Updated the amount.',
  finished: () => 'Marked as used up.',
  discarded: () => 'Marked as thrown away.',
  froze: () => 'Frozen and moved to the freezer.',
  thawed: () => 'Thawed and moved to the fridge.',
  opened: () => 'Marked as opened.',
  moved: (to) => `Moved to the ${to}.`,
};
const STATUS_LABEL: Record<string, string> = { voided: 'removed' };
const isReceipt = (label: string) => label.startsWith('Receipt:');

export function Item() {
  const { lotId = '' } = useParams();
  const { data, error, loading, reload } = useLoad(() => api.item(lotId), [lotId]);
  const undoKey = useRef(newKey());
  const [moveTo, setMoveTo] = useState('');
  const [lastChange, setLastChange] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading && !data) return <p className="muted">Loading…</p>;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const l = data.lot;

  async function act(kind: ItemActivityKind, extra: { fraction?: number; to_location?: string } = {}) {
    if (kind === 'discarded' && !window.confirm(`Mark ${l.food.name} as thrown away?`)) return;
    setBusy(true);
    try {
      const r = await api.itemActivity(l.lot_id, { kind, ...extra, idempotency_key: newKey() });
      setMessage(r.applied.length ? DONE[kind](extra.to_location) : r.unresolved[0]?.reason ?? 'Nothing changed.');
      setLastChange(r.change_set_id);
      setMoveTo('');
      reload();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Could not update. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function undoLast() {
    if (!lastChange) return;
    setBusy(true);
    try {
      await api.undo(lastChange, newKey());
      setMessage('Undone.');
      setLastChange(null);
      reload();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Could not undo. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function undo(changeSetId: string, label: string) {
    const question = isReceipt(label)
      ? `Undo this receipt? This removes every item added from it, not just ${l.food.name}. You can review and add it again afterwards.`
      : 'Undo this change?';
    if (!window.confirm(question)) return;
    setBusy(true);
    try {
      const r = await api.undo(changeSetId, undoKey.current);
      undoKey.current = newKey();
      setMessage(isReceipt(r.label) ? 'Undid the receipt.' : 'Undid the change.');
      reload();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Could not undo. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <header>
        <p className="eyebrow">
          {l.location}
          {l.status !== 'active' ? ` · ${STATUS_LABEL[l.status] ?? l.status.replace(/_/g, ' ')}` : ''}
        </p>
        <h1>{l.food.name}</h1>
      </header>
      {message && (
        <div className="banner" role="status">
          {message}{' '}
          {lastChange && (
            <button className="link" onClick={undoLast} disabled={busy}>
              Undo
            </button>
          )}
        </div>
      )}

      <section className="card">
        <dl className="facts">
          <dt>Amount</dt>
          <dd>{amount(l.quantity_text)}</dd>
          <dt>Expiry</dt>
          <dd>
            <ExpiryBadge expires={l.expires} urgency={l.urgency} today={data.today} />
            {l.expires && <div className="muted small">{expiryNote(l.expires)}</div>}
          </dd>
          <dt>Type</dt>
          <dd>{l.food.perishability === 'perishable' ? 'Perishable' : 'Shelf-stable'}</dd>
          <dt>Bought</dt>
          <dd>{l.acquired_on ? dateOnly(l.acquired_on) : 'Unknown'}</dd>
          <dt>Last seen</dt>
          <dd>{l.evidence_age_days === null ? 'Never' : cap(ago(l.evidence_age_days))}</dd>
        </dl>
      </section>

      {l.status === 'active' && (
        <section className="card quick-actions" aria-label="Update this item">
          <div className="actions">
            <button onClick={() => act('used', { fraction: 0.5 })} disabled={busy}>
              Used half
            </button>
            <button onClick={() => act('finished')} disabled={busy}>
              Finished
            </button>
            {l.state === 'frozen' ? (
              <button onClick={() => act('thawed')} disabled={busy}>
                Thaw
              </button>
            ) : (
              <button onClick={() => act('froze')} disabled={busy}>
                Freeze
              </button>
            )}
            {l.state === 'sealed' && (
              <button onClick={() => act('opened')} disabled={busy}>
                Opened
              </button>
            )}
            <button onClick={() => act('discarded')} disabled={busy}>
              Discard
            </button>
          </div>
          <div className="row move">
            <label>
              Move to
              <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                <option value="">Choose a place</option>
                {PLACES.filter((pl) => pl !== l.location).map((pl) => (
                  <option key={pl}>{pl}</option>
                ))}
              </select>
            </label>
            <button onClick={() => act('moved', { to_location: moveTo })} disabled={busy || !moveTo}>
              Move
            </button>
          </div>
        </section>
      )}

      <h2>Where this came from</h2>
      <ul className="cards">
        {data.evidence.map((e) => (
          <li className="card" key={e.observation_id}>
            <strong>{e.kind === 'receipt' ? `${e.store ? titleCase(e.store) : 'Store'} receipt` : e.summary}</strong>
            {e.purchased_at && <span className="muted small"> · {dateOnly(e.purchased_at)}</span>}
            {e.line && (
              <div className="raw">
                {e.line}
                {e.price_cents !== null && <span>{money(e.price_cents)}</span>}
              </div>
            )}
            {e.review_url && <Link to={new URL(e.review_url).pathname}>Open receipt review</Link>}
          </li>
        ))}
      </ul>

      <h2>History</h2>
      <ul className="cards">
        {data.history.map((h, i) => (
          <li className="card" key={`${h.change_set_id}-${h.op}-${i}`}>
            <div className="title-row">
              <strong>
                {h.op === 'update_lot' ? h.label : OP_LABEL[h.op] ?? cap(h.op.replace(/_/g, ' '))}
                {isReceipt(h.label) && h.op === 'add_lot' ? ' from a receipt' : ''}
              </strong>
              {h.undone && <span className="badge">Undone</span>}
            </div>
            {!isReceipt(h.label) && h.op !== 'update_lot' && <div className="meta">{h.label}</div>}
            <div className="meta">
              {when(h.at)} · {h.by ?? 'someone'}
              {h.via && !h.via.startsWith('Web') ? ` via ${h.via}` : ''}
            </div>
            {!h.undone && !h.is_undo && l.status !== 'voided' && (
              <div className="actions">
                <button onClick={() => undo(h.change_set_id, h.label)} disabled={busy}>
                  {isReceipt(h.label) ? 'Undo this receipt' : 'Undo this change'}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
