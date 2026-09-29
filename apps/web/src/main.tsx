import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { Layout } from './components/Layout';
import { Inventory } from './pages/Inventory';
import { Item } from './pages/Item';
import { Login } from './pages/Login';
import { Review } from './pages/Review';
import './styles.css';

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Navigate to="/inventory" replace /> },
      { path: '/review/:proposalId', element: <Review /> },
      { path: '/inventory', element: <Inventory /> },
      { path: '/items/:lotId', element: <Item /> },
      { path: '*', element: <p className="muted">Page not found.</p> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
