/**
 * Поднавигация раздела «Аналитика»
 */

import React, { useMemo } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { isNavFeatureEnabled } from '../../utils/userNavSections.js';
import { isProfileFboEnabled } from '../../utils/profileFlags.js';
import './AnalyticsSubNav.css';

const TABS = [
  { to: '/analytics/sales', label: 'Продажи FBS', end: true, sectionKey: 'analytics_sales' },
  { to: '/analytics/fbo-sales', label: 'Продажи FBO', sectionKey: 'analytics_sales', requiresFbo: true },
  { to: '/analytics/categories', label: 'По категориям', sectionKey: 'analytics_sales' },
  { to: '/analytics/abc', label: 'ABC', sectionKey: 'analytics_sales' },
  { to: '/analytics/dynamics', label: 'Динамика', sectionKey: 'analytics_sales' },
  { to: '/analytics/turnover', label: 'Оборачиваемость', sectionKey: 'analytics_sales' },
  { to: '/analytics/lost-revenue', label: 'Упущенная выручка', sectionKey: 'analytics_sales' },
  { to: '/analytics/returns', label: 'Возвраты', sectionKey: 'analytics_sales' },
  { to: '/analytics/dead-stock', label: 'Неликвиды', sectionKey: 'analytics_sales' },
  { to: '/analytics/penalties', label: 'Штрафы', sectionKey: 'analytics_sales' },
  { to: '/analytics/employees', label: 'Сотрудники', sectionKey: 'analytics_sales', adminOnly: true },
  { to: '/analytics/pnl', label: 'ОПиУ', sectionKey: 'analytics_sales', adminOnly: true },
];

export function AnalyticsSubNav() {
  const { isAccountAdmin, isAdmin, features, profile } = useAuth();
  const fboEnabled = isProfileFboEnabled(profile);

  const tabs = useMemo(() => {
    return TABS.filter((tab) => {
      if (tab.requiresFbo && !fboEnabled) return false;
      if (tab.adminOnly) return Boolean(isAccountAdmin || isAdmin);
      if (isAccountAdmin || isAdmin) return true;
      return isNavFeatureEnabled(features, tab.sectionKey);
    });
  }, [features, fboEnabled, isAccountAdmin, isAdmin]);

  if (tabs.length <= 1) return null;

  return (
    <nav className="analytics-subnav" aria-label="Раздел аналитики">
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            `analytics-subnav__link${isActive ? ' analytics-subnav__link--active' : ''}`
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
