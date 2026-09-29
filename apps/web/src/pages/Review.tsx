import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError, newKey } from '../api';
import { ErrorBox } from '../components/ErrorBox';
import { OpCard, type LineActions } from '../components/OpCard';
import { dateOnly, titleCase } from '../format';
import type { Decision, OpView, ResolveResponse } from '../types';
import { useLoad } from '../useLoad';

export function Review() {
  const { proposalId = '' } = useParams();
  const { data, error, loading, setData, reload } = useLoad(() => api.proposal(proposalId), [proposalId]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notDuplicate, setNotDuplicate] = useState(false);

  if (loading && !data) return <p className="muted">Loading…</p>;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const open = data.ops.filter((o) => !o.applied);
  const lotOps = data.ops.filter((o) => o.op === 'add_lot');
  // Follow the verdict: every open line that isn't high confidence needs a look, low confidence first.
  const toCheck = new Set((data.lines_to_check ?? []).map((l) => l.op_id));
  const needsLook = lotOps
    .filter((o) => !o.applied && toCheck.has(o.op_id))
    .sort((a, b) => (a.confidence === 'low' ? 0 : 1) - (b.confidence === 'low' ? 0 : 1));
  const others = lotOps.filter((o) => !needsLook.includes(o));
  const ignored = data.ops.filter((o) => o.op === 'ignore_line');
  const added = lotOps.filter((o) => o.applied).length;
  // Lines nobody has decided on yet; skipped lines stay skipped until someone adds them.
  const remaining = open.filter((o) => o.op === 'add_lot' && o.decision === 'pending');

  /** Every button saves straight away. Lines that never go to inventory (coupons, bag fees) are settled along the way. */
  async function save(decisions: Decision[], apply: boolean, done: (r: ResolveResponse) => string | null) {
    setBusy(true);
    setActionError(null);
    try {
      const settle: Decision[] = apply ? open.filter((o) => o.op === 'ignore_line').map((o) => ({ op_id: o.op_id, action: 'accept' })) : [];
      const res = await api.resolve(proposalId, {
        decisions: [...decisions, ...settle],
        accept_remaining: false,
        apply,
        idempotency_key: newKey(),
        confirm_possible_duplicate: notDuplicate,
      });
      setData(res);
      setSaved(done(res));
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }
  const addedMessage = (r: ResolveResponse) => {
    const n = r.created_lot_ids.length;
    return n ? `Added ${n === 1 ? (r.ops.find((o) => o.change_set_id === r.applied_change_set_id)?.draft?.food_name ?? '1 item') : `${n} items`} to inventory.` : null;
  };

  async function undo(changeSetId: string) {
    setBusy(true);
    setActionError(null);
    try {
      await api.undo(changeSetId, newKey());
      setSaved('Undone. The line is back to review.');
      reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not undo. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const duplicate = data.observation.possible_duplicate_of;
  const duplicateActive = Boolean(duplicate) && open.some((o) => o.op === 'add_lot');
  const needsDuplicateConfirm = duplicateActive && !notDuplicate;
  const otherReasons = (data.verdict?.reasons ?? []).filter((r) => !r.startsWith('May duplicate'));
  const otherNotes = data.observation.uncertainties.filter((u) => !u.includes('already recorded'));

  const actionsFor = (o: OpView): LineActions => ({
    add: (edits) => save([edits ? { op_id: o.op_id, action: 'edit', edits } : { op_id: o.op_id, action: 'accept' }], true, addedMessage),
    skip: () => save([{ op_id: o.op_id, action: 'reject' }], false, () => `Skipped ${o.draft?.food_name ?? 'that line'}.`),
    undo,
    disabled: busy || needsDuplicateConfirm,
  });
  const card = (o: OpView) => <OpCard key={o.op_id} op={o} today={data.today} actions={o.op === 'add_lot' ? actionsFor(o) : undefined} />;

  return (
    <div>
      <header>
        <p className="eyebrow">
          Receipt review{data.observation.purchased_at ? ` · ${dateOnly(data.observation.purchased_at)}` : ''}
        </p>
        <h1>{data.observation.store ? titleCase(data.observation.store) : 'Receipt'}</h1>
        <p className="muted small">
          shared by {data.observation.recorded_by ?? 'someone'}
          {data.observation.via ? ` via ${data.observation.via}` : ''}
        </p>
      </header>
      <div className="stats">
        <div className="stat">
          <b>{data.counts.lines}</b>
          <span>on receipt</span>
        </div>
        <div className={`stat${toCheck.size > 0 ? ' warn' : ''}`} data-testid="stat-to-check">
          <b>{toCheck.size}</b>
          <span>to check</span>
        </div>
        <div className="stat">
          <b>{added}</b>
          <span>added</span>
        </div>
      </div>

      {saved && (
        <div className="banner ok" role="status">
          {saved} <Link to="/inventory">View inventory</Link>
        </div>
      )}
      {!saved && data.proposal.status === 'applied' && (
        <div className="banner ok">
          This receipt is done. <Link to="/inventory">View inventory</Link>
        </div>
      )}
      {data.verdict && added === 0 && !duplicateActive && (
        <div className={`banner ${data.verdict.verdict === 'safe_to_apply' ? 'ok' : data.verdict.verdict === 'quick_check' ? '' : 'warn'}`} data-testid="verdict">
          <strong>
            {data.verdict.verdict === 'safe_to_apply' ? 'Looks right.' : data.verdict.verdict === 'quick_check' ? 'Mostly confident.' : 'Needs a review.'}
          </strong>{' '}
          {data.verdict.reasons.join(' · ')}.{' '}
          {data.verdict.verdict === 'safe_to_apply'
            ? 'You can add everything.'
            : data.verdict.verdict === 'quick_check'
              ? 'Check the marked lines, then add.'
              : 'Look through the lines below before adding.'}
        </div>
      )}
      {actionError && (
        <div className="banner error" role="alert">
          {actionError}
        </div>
      )}
      {duplicate && duplicateActive && (
        <div className="banner warn" role="alert">
          <strong>This receipt may already be recorded.</strong> Another receipt from the same store and day has the same total or
          nearly the same lines. Applying both would count these items twice.{' '}
          {duplicate.review_url && <Link to={new URL(duplicate.review_url).pathname}>Open the earlier receipt</Link>}
          {otherReasons.length > 0 && <div className="small">Also: {otherReasons.join(' · ')}.</div>}
          <label className="check">
            <input type="checkbox" checked={notDuplicate} onChange={(e) => setNotDuplicate(e.target.checked)} /> This is a different purchase
          </label>
        </div>
      )}
      {otherNotes.length > 0 && (
        <ul className="notes">
          {otherNotes.map((n) => (
            <li key={n} className="muted small">
              {n}
            </li>
          ))}
        </ul>
      )}

      {needsLook.length > 0 && (
        <section>
          <h2 className="warn">
            <span>Needs a look</span>
            <span className="n">{needsLook.length}</span>
          </h2>
          <ul className="rows warn">{needsLook.map(card)}</ul>
        </section>
      )}
      {others.length > 0 && (
        <section>
          <h2>
            <span>Items</span>
            <span className="n">{others.length}</span>
          </h2>
          <ul className="rows">{others.map(card)}</ul>
        </section>
      )}
      {ignored.length > 0 && (
        <section>
          <h2>Not added to inventory</h2>
          <ul className="rows quiet">{ignored.map(card)}</ul>
        </section>
      )}

      {remaining.length > 1 && (
        <div className="action-bar">
          <div className="action-bar-inner">
            <span>
              {remaining.length} items not added yet
            </span>
            <button
              className="primary"
              onClick={() => save(remaining.map((o) => ({ op_id: o.op_id, action: 'accept' })), true, addedMessage)}
              disabled={busy || needsDuplicateConfirm}
            >
              {busy ? 'Saving…' : `Add all ${remaining.length}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
