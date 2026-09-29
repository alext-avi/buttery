import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { ExpiryBadge } from '../components/Badges';
import { ErrorBox } from '../components/ErrorBox';
import { cap } from '../format';
import type { LotView } from '../types';
import { useLoad } from '../useLoad';

function LotRow({ lot, showLocation }: { lot: LotView; showLocation?: boolean }) {
  return (
    <li className="card" data-testid="lot">
      <Link className="lot" to={`/items/${lot.lot_id}`}>
        <span>
          <strong>{lot.food.name}</strong>
          <span className="meta">
            {' '}
            {lot.quantity_text}
            {showLocation ? ` · ${lot.location}` : ''}
          </span>
        </span>
        <span className="right">
          <ExpiryBadge text={lot.expiry_text} urgency={lot.urgency} kind={lot.expires?.kind} />
          {lot.evidence_age_days !== null && lot.evidence_age_days > 0 && <div className="muted small">seen {lot.evidence_age_days}d ago</div>}
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

  return (
    <div>
      <header>
        <h1>Inventory</h1>
        <p className="muted">
          {total} item{total === 1 ? '' : 's'}
          {location ? ` in ${location}` : ''}
        </p>
      </header>
      <div className="chips">
        <Link className={!location ? 'active' : ''} to="/inventory">
          All
        </Link>
        {data.locations.map((l) => (
          <Link key={l} className={location === l ? 'active' : ''} to={`/inventory?location=${l}`}>
            {cap(l)}
          </Link>
        ))}
      </div>

      <section>
        <h2>Use soon</h2>
        {soon.length === 0 ? (
          <p className="muted">Nothing expiring in the next week.</p>
        ) : (
          <ul className="cards">
            {soon.map((l) => (
              <LotRow key={l.lot_id} lot={l} showLocation={!location} />
            ))}
          </ul>
        )}
      </section>

      {!useSoonOnly &&
        Object.entries(data.by_location).map(([loc, items]) => (
          <section key={loc}>
            <h2>
              {cap(loc)} · {items.length}
            </h2>
            <ul className="cards">
              {items.map((l) => (
                <LotRow key={l.lot_id} lot={l} />
              ))}
            </ul>
          </section>
        ))}
      {total === 0 && <p className="muted">Nothing here yet. Share a receipt with your agent to get started.</p>}
    </div>
  );
}
