import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError, newKey } from '../api';
import { ExpiryBadge } from '../components/Badges';
import { ErrorBox } from '../components/ErrorBox';
import { money, when } from '../format';
import { useLoad } from '../useLoad';

const OP_LABEL: Record<string, string> = { add_lot: 'Added', void_lot: 'Removed (undo)' };

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
  const models = [...new Set(data.reasoning.map((r) => r.model).filter(Boolean))];

  async function undo(changeSetId: string, label: string) {
    const isReceipt = label.startsWith('Receipt:');
    const question = isReceipt
      ? `Undo “${label}”? This removes every item added from that receipt, not just ${l.food.name}. You can review and re-apply the receipt afterwards.`
      : `Undo “${label}”?`;
    if (!window.confirm(question)) return;
    setBusy(true);
    try {
      const r = await api.undo(changeSetId, undoKey.current);
      undoKey.current = newKey();
      setMessage(`Undid “${r.label}”.`);
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
          {l.status !== 'active' ? ` · ${l.status}` : ''}
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
          <dd>{l.quantity_text}</dd>
          <dt>Expiry</dt>
          <dd>
            <ExpiryBadge text={l.expiry_text} urgency={l.urgency} kind={l.expires?.kind} />
            {l.expires && <div className="muted small">{l.expires.kind === 'printed' ? 'Printed on the package' : `Estimated: ${l.expires.basis}`}</div>}
          </dd>
          <dt>Type</dt>
          <dd>{l.food.perishability === 'perishable' ? 'Perishable' : 'Shelf-stable'}</dd>
          <dt>Bought</dt>
          <dd>{l.acquired_on ?? 'unknown'}</dd>
          <dt>Last seen</dt>
          <dd>{l.evidence_age_days === null ? 'never' : l.evidence_age_days === 0 ? 'today' : `${l.evidence_age_days} days ago`}</dd>
        </dl>
      </section>

      <h2>Evidence</h2>
      <ul className="cards">
        {data.evidence.map((e) => (
          <li className="card" key={e.observation_id}>
            <strong>{e.summary}</strong>
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
      {models.length > 0 && <p className="muted small">Name and shelf life estimated by {models.join(', ')}.</p>}

      <h2>History</h2>
      <ul className="cards">
        {data.history.map((h) => (
          <li className="card" key={`${h.change_set_id}-${h.op}`}>
            <div className="title-row">
              <strong>{OP_LABEL[h.op] ?? h.op}</strong>
              {h.undone && <span className="badge">Undone</span>}
            </div>
            <div className="meta">
              {h.label} · {when(h.at)} · {h.by ?? 'someone'}
              {h.via ? ` via ${h.via}` : ''}
            </div>
            {!h.undone && !h.is_undo && l.status === 'active' && (
              <div className="actions">
                <button onClick={() => undo(h.change_set_id, h.label)} disabled={busy}>
                  {h.label.startsWith('Receipt:') ? 'Undo this receipt' : 'Undo this change'}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
