import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { useAuth } from './auth.jsx';
import { Spinner } from './components.jsx';
import DispatchPage from './pages/Dispatch.jsx';
import DriverQueuePage from './pages/DriverQueue.jsx';
import LoginPage from './pages/Login.jsx';
import OrderDetailPage from './pages/OrderDetail.jsx';
import OrdersPage from './pages/Orders.jsx';
import ReportsPage from './pages/Reports.jsx';
import ScanPage from './pages/Scan.jsx';
import SettingsPage from './pages/Settings.jsx';
import TrackPage from './pages/Track.jsx';

/** Route guard. `roles` omitted means "any signed-in user". */
function Protected({ roles, children }) {
  const { user, checking } = useAuth();
  const location = useLocation();

  if (checking) return <div className="page-centre"><Spinner /></div>;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

function NavBar() {
  const { user, signOut, isDriver, isStaff } = useAuth();
  if (!user) return null;

  return (
    <header className="topbar">
      <div className="topbar__inner">
        <div className="topbar__brand">
          <span className="topbar__mark" aria-hidden="true">◧</span>
          <span>Deliveries</span>
        </div>

        <nav className="topbar__nav" aria-label="Main">
          {isDriver ? <NavLink to="/queue">My queue</NavLink> : null}
          <NavLink to="/scan">Scan</NavLink>
          {isStaff ? <NavLink to="/orders">Orders</NavLink> : null}
          {isStaff ? <NavLink to="/dispatch">Dispatch</NavLink> : null}
          {isStaff ? <NavLink to="/reports">Reports</NavLink> : null}
          {isStaff ? <NavLink to="/settings">Settings</NavLink> : null}
        </nav>

        <div className="topbar__user">
          <span className="topbar__name">
            {user.fullName}
            <span className="topbar__role">{user.role}</span>
          </span>
          <button type="button" className="button button--ghost button--sm" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

/** Sends each role to the screen they actually start their day on. */
function HomeRedirect() {
  const { user, checking } = useAuth();
  if (checking) return <div className="page-centre"><Spinner /></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={user.role === 'driver' ? '/queue' : '/orders'} replace />;
}

export default function App() {
  const location = useLocation();
  // The public tracking page has no chrome — it is for customers, not staff.
  const isPublic = location.pathname.startsWith('/track/');

  return (
    <div className={isPublic ? 'app app--public' : 'app'}>
      {isPublic ? null : <NavBar />}

      <main className="app__main">
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/track/:token" element={<TrackPage />} />

          <Route path="/" element={<HomeRedirect />} />
          <Route path="/scan" element={<Protected><ScanPage /></Protected>} />
          <Route
            path="/queue"
            element={<Protected roles={['driver']}><DriverQueuePage /></Protected>}
          />
          <Route
            path="/orders"
            element={<Protected roles={['admin', 'dispatcher']}><OrdersPage /></Protected>}
          />
          <Route path="/orders/:id" element={<Protected><OrderDetailPage /></Protected>} />
          <Route
            path="/dispatch"
            element={<Protected roles={['admin', 'dispatcher']}><DispatchPage /></Protected>}
          />
          <Route
            path="/reports"
            element={<Protected roles={['admin', 'dispatcher']}><ReportsPage /></Protected>}
          />
          {/* Dispatchers can see settings read-only; only admins can change them. */}
          <Route
            path="/settings"
            element={<Protected roles={['admin', 'dispatcher']}><SettingsPage /></Protected>}
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
