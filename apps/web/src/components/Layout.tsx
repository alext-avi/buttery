import { Link, NavLink, Outlet } from 'react-router';

export function Layout() {
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
        <Outlet />
      </main>
    </>
  );
}
