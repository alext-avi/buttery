import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError, newKey } from '../api';
import { ErrorBox } from '../components/ErrorBox';
import { OpCard, type Choice } from '../components/OpCard';
import { dateOnly } from '../format';
import type { Decision, OpView, ResolveResponse } from '../types';
import { useLoad } from '../useLoad';

export function Review() {
  const { proposalId = '' } = useParams();
  const { data, error, loading, setData, reload } = useLoad(() => api.proposal(proposalId), [proposalId]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResolveResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const applyKey = useRef(newKey());
  const undoKey = useRef(newKey());

  if (loading && !data) return <p className="muted">Loading…</p>;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const choiceFor = (o: OpView): Choice => choices[o.op_id] ?? (o.decision === 'rejected' ? { action: 'reject' } : { action: 'accept' });
  const setChoice = (id: string) => (c: Choice) => {
    setChoices((prev) => ({ ...prev, [id]: c }));
    applyKey.current = newKey();
  };
  const open = data.ops.filter((o) => !o.applied);
  const lotOps = data.ops.filter((o) => o.op === 'add_lot');
  const needsLook = lotOps.filter((o) => !o.applied && o.confidence === 'low');
  const others = lotOps.filter((o) => !needsLook.includes(o));
  const ignored = data.ops.filter((o) => o.op === 'ignore_line');
  const adding = open.filter((o) => o.op === 'add_lot' && choiceFor(o).action !== 'reject').length;

  async function apply() {
    setBusy(true);
    setActionError(null);
    try {
      const decisions: Decision[] = open.map((o) => {
        const c = o.op === 'ignore_line' ? ({ action: 'accept' } as Choice) : choiceFor(o);
        return c.action === 'edit' ? { op_id: o.op_id, action: 'edit', edits: c.edits } : { op_id: o.op_id, action: c.action };
      });
      const res = await api.resolve(proposalId, { decisions, accept_remaining: false, apply: true, idempotency_key: applyKey.current });
      applyKey.current = newKey();
      setChoices({});
      setResult(res);
      setData(res);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!result?.applied_change_set_id) return;
    setBusy(true);
    try {
      await api.undo(result.applied_change_set_id, undoKey.current);
      undoKey.current = newKey();
      setResult(null);
      reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not undo. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const card = (o: OpView) => <OpCard key={o.op_id} op={o} choice={choiceFor(o)} onChange={o.applied ? undefined : setChoice(o.op_id)} />;

  return (
    <div>
      <header>
        <p className="eyebrow">Receipt review</p>
        <h1>{data.observation.store ?? 'Receipt'}</h1>
        <p className="muted">
          {dateOnly(data.observation.purchased_at)} · shared by {data.observation.recorded_by ?? 'someone'}
          {data.observation.via ? ` via ${data.observation.via}` : ''}
        </p>
      </header>

      {result?.applied_change_set_id && (
        <div className="banner ok" role="status">
          <strong>
            Added {result.created_lot_ids.length} item{result.created_lot_ids.length === 1 ? '' : 's'}
          </strong>{' '}
          to inventory.{' '}
          <button className="link" onClick={undo} disabled={busy}>
            Undo
          </button>{' '}
          · <Link to="/inventory">View inventory</Link>
        </div>
      )}
      {!result && data.proposal.status === 'applied' && (
        <div className="banner ok">
          This receipt is done. <Link to="/inventory">View inventory</Link>
        </div>
      )}
      {actionError && (
        <div className="banner error" role="alert">
          {actionError}
        </div>
      )}

      {needsLook.length > 0 && (
        <section>
          <h2>Needs a look ({needsLook.length})</h2>
          <ul className="cards">{needsLook.map(card)}</ul>
        </section>
      )}
      {others.length > 0 && (
        <section>
          <h2>Items ({others.length})</h2>
          <ul className="cards">{others.map(card)}</ul>
        </section>
      )}
      {ignored.length > 0 && (
        <section>
          <h2>Not added to inventory</h2>
          <ul className="cards">{ignored.map(card)}</ul>
        </section>
      )}

      {open.length > 0 && (
        <div className="action-bar">
          <button className="primary" onClick={apply} disabled={busy}>
            {busy ? 'Saving…' : adding > 0 ? `Add ${adding} item${adding === 1 ? '' : 's'}` : 'Confirm'}
          </button>
        </div>
      )}
    </div>
  );
}
