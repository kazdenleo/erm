/**
 * Оболочка админки продукта: без ERP-сайдбара, отдельная навигация.
 */

import React from 'react';
import { NavLink, Outlet, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import './platform.css';

const nav = [
  { to: '/platform/accounts', label: 'Аккаунты' },
  { to: '/platform/inquiries', label: 'Обращения' },
];

export function PlatformLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="platform-shell app-theme-white">
      <header className="platform-header">
        <div className="platform-header__brand">
          <Link to="/platform/accounts" className="platform-header__title">
            Администрирование продукта
          </Link>
        </div>
        <nav className="platform-header__nav" aria-label="Разделы админки">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `platform-nav-link${isActive ? ' platform-nav-link--active' : ''}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="platform-header__actions">
          <Link to="/" className="platform-link-erp">
            В приложение ERP
          </Link>
          <span className="platform-user-email" title={user?.email}>
            {user?.fullName || user?.email}
          </span>
          <button type="button" className="btn btn-sm btn-outline-danger" onClick={handleLogout}>
            Выход
          </button>
        </div>
      </header>
      <main className="platform-main">
        <Outlet />
      </main>
    </div>
  );
}
