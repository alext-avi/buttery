import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError, newKey } from '../api';
import { ExpiryBadge } from '../components/Badges';
import { ErrorBox } from '../components/ErrorBox';
import { ago, amount, cap, dateOnly, expiryNote, money, titleCase, when } from '../format';
import { useLoad } from '../useLoad';

const OP_LABEL: Record<string, string> = { add_lot: 'Added', void_lot: 'Removed' };
const STATUS_LABEL: Record<string, string> = { voided: 'removed' };
const isReceipt = (label: string) => label.startsWith('Receipt:');

export function Item() {
  const { lotId = '' } = useParams();
  const { data, error, loading, reload } = useLoad(() => api.item(lotId), [lotId]);
  const undoKey = useRef(newKey());
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading && !data) return <p className="muted">Loading…</p>;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const l = data.lot;

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
          {message}
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

      <h2>Where this came from</h2>
      <ul className="cards">
        {data.evidence.map((e) => (
          <li className="card" key={e.observation_id}>
            <strong>{e.kind === 'receipt' ? `${e.store ? titleCase(e.store) : 'Store'} receipt` : cap(e.kind)}</strong>
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
        {data.history.map((h) => (
          <li className="card" key={`${h.change_set_id}-${h.op}`}>
            <div className="title-row">
              <strong>
                {OP_LABEL[h.op] ?? cap(h.op.replace(/_/g, ' '))}
                {isReceipt(h.label) && h.op === 'add_lot' ? ' from a receipt' : ''}
              </strong>
              {h.undone && <span className="badge">Undone</span>}
            </div>
            {!isReceipt(h.label) && <div className="meta">{h.label}</div>}
            <div className="meta">
              {when(h.at)} · {h.by ?? 'someone'}
              {h.via && h.via !== 'Web' ? ` via ${h.via}` : ''}
            </div>
            {!h.undone && !h.is_undo && l.status === 'active' && (
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
