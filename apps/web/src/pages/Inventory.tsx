import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { ExpiryBadge } from '../components/Badges';
import { ErrorBox } from '../components/ErrorBox';
import { ago, amount, cap, dateOnly } from '../format';
import type { LotView } from '../types';
import { useLoad } from '../useLoad';

function LotRow({ lot, today, showLocation }: { lot: LotView; today: string; showLocation?: boolean }) {
  const flagged = lot.urgency && lot.urgency !== 'later';
  return (
    <li className="lot-item" data-testid="lot">
      <Link className="lot" to={`/items/${lot.lot_id}`}>
        {flagged && <span className={`dot ${lot.urgency}`} aria-hidden="true" />}
        <span className="main">
          <strong>{lot.food.name}</strong>
          <span className="meta">
            {amount(lot.quantity_text)}
            {showLocation ? ` · ${lot.location}` : ''}
          </span>
        </span>
        <span className="right">
          <ExpiryBadge expires={lot.expires} urgency={lot.urgency} today={today} />
          {lot.evidence_age_days !== null && lot.evidence_age_days > 0 && <span className="muted small">seen {ago(lot.evidence_age_days)}</span>}
        </span>
      </Link>
    </li>
  );
}

export function Inventory() {
  const [params] = useSearchParams();
  const location = params.get('location') ?? '';
  const useSoonOnly = params.get('view') === 'use-soon';
  const { data, error, loading } = useLoad(() => api.inventory(location || undefined), [location]);

  if (loading && !data) return <p className="muted">Loading…</p>;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const soon = [...data.use_soon.expired, ...data.use_soon.urgent, ...data.use_soon.soon];
  const total = Object.values(data.by_location).reduce((n, items) => n + items.length, 0);
  const { counts } = data;
  const tiles = data.locations.filter((l) => (counts.by_location[l] ?? 0) > 0 || l === location);

  return (
    <div>
      <header className="page-head">
        <h1>Inventory</h1>
        <span className="stamp">{dateOnly(data.today)}</span>
      </header>
      <nav className="stats" aria-label="Filter inventory">
        <Link className={`stat${!location && !useSoonOnly ? ' active' : ''}`} to="/inventory" aria-current={!location && !useSoonOnly ? 'page' : undefined}>
          <b>{counts.total}</b>
          <span>All</span>
        </Link>
        <Link className={`stat${counts.use_soon > 0 ? ' warn' : ''}${useSoonOnly ? ' active' : ''}`} to="/inventory?view=use-soon" aria-current={useSoonOnly ? 'page' : undefined}>
          <b>{counts.use_soon}</b>
          <span>Use soon</span>
        </Link>
        {tiles.map((l) => (
          <Link key={l} className={`stat${location === l ? ' active' : ''}`} to={`/inventory?location=${l}`} aria-current={location === l ? 'page' : undefined}>
            <b>{counts.by_location[l] ?? 0}</b>
            <span>{cap(l)}</span>
          </Link>
        ))}
      </nav>

      <section>
        <h2 className={soon.length > 0 ? 'warn' : undefined}>
          <span>Use soon</span>
          <span className="n">{soon.length}</span>
        </h2>
        {soon.length === 0 ? (
          <p className="muted">Nothing expiring in the next week.</p>
        ) : (
          <ul className="rows">
            {soon.map((l) => (
              <LotRow key={l.lot_id} lot={l} today={data.today} showLocation={!location} />
            ))}
          </ul>
        )}
      </section>

      {!useSoonOnly &&
        Object.entries(data.by_location).map(([loc, items]) => (
          <section key={loc}>
            <h2>
              <span>{cap(loc)}</span>
              <span className="n">{items.length}</span>
            </h2>
            <ul className="rows">
              {items.map((l) => (
                <LotRow key={l.lot_id} lot={l} today={data.today} />
              ))}
            </ul>
          </section>
        ))}
      {total === 0 && <p className="muted">Nothing here yet. Share a receipt with your agent to get started.</p>}
    </div>
  );
}
