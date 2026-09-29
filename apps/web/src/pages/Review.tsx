import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError, newKey } from '../api';
import { ErrorBox } from '../components/ErrorBox';
import { OpCard, type Choice } from '../components/OpCard';
import { dateOnly, titleCase } from '../format';
import type { Decision, OpView, ResolveResponse } from '../types';
import { useLoad } from '../useLoad';

export function Review() {
  const { proposalId = '' } = useParams();
  const { data, error, loading, setData, reload } = useLoad(() => api.proposal(proposalId), [proposalId]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResolveResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notDuplicate, setNotDuplicate] = useState(false);
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
  // Follow the verdict: every open line that isn't high confidence needs a look, low confidence first.
  const toCheck = new Set((data.lines_to_check ?? []).map((l) => l.op_id));
  const needsLook = lotOps
    .filter((o) => !o.applied && toCheck.has(o.op_id))
    .sort((a, b) => (a.confidence === 'low' ? 0 : 1) - (b.confidence === 'low' ? 0 : 1));
  const others = lotOps.filter((o) => !needsLook.includes(o));
  const ignored = data.ops.filter((o) => o.op === 'ignore_line');
  const openLots = open.filter((o) => o.op === 'add_lot').length;
  const added = lotOps.filter((o) => o.applied && o.decision !== 'rejected').length;
  const adding = open.filter((o) => o.op === 'add_lot' && choiceFor(o).action !== 'reject').length;

  async function apply() {
    setBusy(true);
    setActionError(null);
    try {
      const decisions: Decision[] = open.map((o) => {
        const c = o.op === 'ignore_line' ? ({ action: 'accept' } as Choice) : choiceFor(o);
        return c.action === 'edit' ? { op_id: o.op_id, action: 'edit', edits: c.edits } : { op_id: o.op_id, action: c.action };
      });
      const res = await api.resolve(proposalId, {
        decisions,
        accept_remaining: false,
        apply: true,
        idempotency_key: applyKey.current,
        confirm_possible_duplicate: notDuplicate,
      });
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

  const duplicate = data.observation.possible_duplicate_of;
  const duplicateActive = Boolean(duplicate) && open.some((o) => o.op === 'add_lot');
  const needsDuplicateConfirm = duplicateActive && !notDuplicate;
  const otherReasons = (data.verdict?.reasons ?? []).filter((r) => !r.startsWith('May duplicate'));
  const otherNotes = data.observation.uncertainties.filter((u) => !u.includes('already recorded'));

  const card = (o: OpView) => <OpCard key={o.op_id} op={o} today={data.today} choice={choiceFor(o)} onChange={o.applied ? undefined : setChoice(o.op_id)} />;

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
          <b>{open.length > 0 ? adding : added}</b>
          <span>{open.length > 0 ? 'adding' : 'added'}</span>
        </div>
      </div>

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
      {data.verdict && !result && !duplicateActive && (
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

      {open.length > 0 && (
        <div className="action-bar">
          <div className="action-bar-inner">
            <span>{openLots > 0 ? `${adding} of ${openLots} item${openLots === 1 ? '' : 's'} will be added` : 'Nothing new to add'}</span>
            <button className="primary" onClick={apply} disabled={busy || needsDuplicateConfirm}>
              {busy ? 'Saving…' : adding > 0 ? `Add ${adding} item${adding === 1 ? '' : 's'}` : 'Confirm'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
