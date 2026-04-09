import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../../context/AuthContext.jsx';
import { useNotificationsCount } from '../../../hooks/useNotificationsCount';
import './Header.css';

export function Header({ isSidebarClosed, onToggleSidebar, isMobileSidebarOpen, onToggleMobileSidebar }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, isAdmin, profileId, logout } = useAuth();
  const notificationsCount = useNotificationsCount();
  const onNotifications = location.pathname.startsWith('/notifications');
  const onSupport = location.pathname.startsWith('/support');
  const onCabinet = location.pathname.startsWith('/cabinet');
  const onPlatform = location.pathname.startsWith('/platform');

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="app-header header-shadow">
      <div className="app-header__logo">
        <div className="logo-src" />
        <div className="header__pane ms-auto">
          <div>
            <button
              type="button"
              className={`hamburger close-sidebar-btn hamburger--elastic ${isSidebarClosed ? 'is-active' : ''}`}
              onClick={onToggleSidebar}
              aria-label={isSidebarClosed ? 'Развернуть меню' : 'Свернуть меню'}
            >
              <span className="hamburger-box">
                <span className="hamburger-inner" />
              </span>
            </button>
          </div>
        </div>
      </div>

      <div className="app-header__mobile-menu">
        <div>
          <button
            type="button"
            className={`hamburger hamburger--elastic mobile-toggle-nav ${isMobileSidebarOpen ? 'is-active' : ''}`}
            onClick={onToggleMobileSidebar}
            aria-label={isMobileSidebarOpen ? 'Закрыть меню' : 'Открыть меню'}
          >
            <span className="hamburger-box">
              <span className="hamburger-inner" />
            </span>
          </button>
        </div>
      </div>

      <div className="app-header__content">
        <div className="app-header-left">
          <div className="search-wrapper">
            <div className="input-holder">
              <input className="search-input" placeholder="Поиск..." />
              <button type="button" className="search-icon" aria-label="Поиск">
                <span />
              </button>
            </div>
            <button type="button" className="btn-close" aria-label="Закрыть поиск" />
          </div>
        </div>
        <div className="header-quick-actions" aria-label="Уведомления, профиль и техподдержка">
          <Link
            to="/notifications"
            className={`header-quick-action${onNotifications ? ' header-quick-action--active' : ''}`}
            title="Уведомления"
            aria-label="Уведомления"
          >
            <i className="pe-7s-bell" aria-hidden />
            {notificationsCount > 0 ? (
              <span className="header-quick-action__badge">
                {notificationsCount > 99 ? '99+' : notificationsCount}
              </span>
            ) : null}
          </Link>
          <Link
            to="/support"
            className={`header-quick-action${onSupport ? ' header-quick-action--active' : ''}`}
            title="Техподдержка"
            aria-label="Техподдержка"
          >
            <i className="pe-7s-mail" aria-hidden />
          </Link>
          {user ? (
            <div
              className="header-profile"
              title={user.fullName || user.email || 'Профиль'}
            >
              <button
                type="button"
                className={`header-quick-action header-profile__trigger${onCabinet || onPlatform ? ' header-quick-action--active' : ''}`}
                aria-label="Меню профиля"
                aria-haspopup="true"
                aria-expanded="false"
              >
                <i className="pe-7s-user" aria-hidden />
                {isAdmin ? <span className="header-profile__admin-dot" title="Администратор" aria-hidden /> : null}
              </button>
              <div className="header-profile__menu" role="menu">
                {profileId != null ? (
                  <Link role="menuitem" to="/cabinet" className="header-profile__item">
                    Изменить
                  </Link>
                ) : null}
                {isAdmin ? (
                  <Link role="menuitem" to="/platform/accounts" className="header-profile__item">
                    Админка продукта
                  </Link>
                ) : null}
                <button type="button" role="menuitem" className="header-profile__item header-profile__item--danger" onClick={handleLogout}>
                  Выход
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

