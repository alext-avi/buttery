import { Link, NavLink, Outlet, useSearchParams } from 'react-router';
import { OpenLink } from './OpenLink';

export function Layout() {
  const [params] = useSearchParams();
  const code = params.get('login');
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/inventory" className="brand">
            buttery<span>.</span>
          </Link>
          <nav>
            <NavLink to="/inventory">Inventory</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
        </div>
      </header>
      <main>
        {code ? <OpenLink code={code} /> : <Outlet />}
      </main>
    </>
  );
}
