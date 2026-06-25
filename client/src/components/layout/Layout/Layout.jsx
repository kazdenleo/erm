/**
 * Layout Component
 * Основной layout компонент приложения
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Header } from '../Header/Header';
import { Sidebar } from '../Sidebar/Sidebar';
import { useAuth } from '../../../context/AuthContext.jsx';
import { useNewOrdersSound } from '../../../hooks/useNewOrdersSound';
import { ProductCardModalProvider } from '../../../context/ProductCardModalContext.jsx';
import { NavSectionGuard } from '../../NavSectionGuard.jsx';

export function Layout({ children }) {
  const [isSidebarClosed, setIsSidebarClosed] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const { user, profileId, hasOrganizations, loading: authLoading } = useAuth();

  // Глобальный звук "Новый заказ": работает на любой странице, пока пользователь авторизован.
  useNewOrdersSound({ enabled: Boolean(user?.id), profileId });

  const toggleSidebar = useCallback(() => {
    setIsSidebarClosed((v) => !v);
  }, []);

  const toggleMobileSidebar = useCallback(() => {
    setIsMobileSidebarOpen((v) => !v);
  }, []);

  useEffect(() => {
    if (!isMobileSidebarOpen) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setIsMobileSidebarOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMobileSidebarOpen]);

  return (
    <ProductCardModalProvider>
      <div
        className={[
          'app-container',
          'app-theme-white',
          'body-tabs-shadow',
          'fixed-sidebar',
          'fixed-header',
          isSidebarClosed ? 'closed-sidebar' : '',
          isMobileSidebarOpen ? 'sidebar-mobile-open' : '',
        ].filter(Boolean).join(' ')}
      >
        <Header
          isSidebarClosed={isSidebarClosed}
          onToggleSidebar={toggleSidebar}
          isMobileSidebarOpen={isMobileSidebarOpen}
          onToggleMobileSidebar={toggleMobileSidebar}
        />
        <div className="app-main">
          <Sidebar />
          <div className="app-main__outer">
            <div className="app-main__inner">
              {!authLoading && user && profileId != null && hasOrganizations === false && (
                <div
                  className="alert alert-warning mx-3 mt-3 mb-0"
                  role="alert"
                  style={{ borderRadius: 8 }}
                >
                  У вашего аккаунта нет ни одной организации. Обратитесь к администратору аккаунта или создайте
                  организацию в разделе «Настройки → Организации».
                </div>
              )}
              {children && <NavSectionGuard>{children}</NavSectionGuard>}
            </div>
          </div>
        </div>
      </div>
    </ProductCardModalProvider>
  );
}

