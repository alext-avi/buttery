import { Link, NavLink, Outlet } from 'react-router';

export function Layout() {
  return (
    <>
      <header className="topbar">
        <Link to="/inventory" className="brand">
          Buttery
        </Link>
        <nav>
          <NavLink to="/inventory">Inventory</NavLink>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  );
}
