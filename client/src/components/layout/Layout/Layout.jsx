/**
 * Layout Component
 * Основной layout компонент приложения
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Header } from '../Header/Header';
import { Sidebar } from '../Sidebar/Sidebar';

export function Layout({ children }) {
  const [isSidebarClosed, setIsSidebarClosed] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

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
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

