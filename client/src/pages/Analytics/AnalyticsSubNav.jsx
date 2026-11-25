/**
 * Поднавигация раздела «Аналитика»:
 * - на хабе — скрыта;
 * - на отчёте — только отчёты текущей группы + «Все отчёты».
 */

import React, { useMemo } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { isNavFeatureEnabled } from '../../utils/userNavSections.js';
import { isProfileFboEnabled } from '../../utils/profileFlags.js';
import { filterAnalyticsGroups, findAnalyticsGroupByPath } from './analyticsNav.js';
import './AnalyticsSubNav.css';

export function AnalyticsSubNav() {
  const { pathname } = useLocation();
  const { isAccountAdmin, isAdmin, features, profile } = useAuth();
  const fboEnabled = isProfileFboEnabled(profile);

  const groups = useMemo(
    () =>
      filterAnalyticsGroups({
        features,
        isAccountAdmin,
        isAdmin,
        fboEnabled,
        isNavFeatureEnabled,
      }),
    [features, fboEnabled, isAccountAdmin, isAdmin]
  );

  const isHub = pathname === '/analytics' || pathname === '/analytics/';
  const currentGroup = useMemo(
    () => findAnalyticsGroupByPath(pathname, groups),
    [groups, pathname]
  );

  if (isHub || !currentGroup) return null;

  return (
    <nav className="analytics-subnav" aria-label="Раздел аналитики">
      <NavLink to="/analytics" end className="analytics-subnav__hub">
        Все отчёты
      </NavLink>
      <span className="analytics-subnav__group" title={currentGroup.description || undefined}>
        {currentGroup.label}
      </span>
      <span className="analytics-subnav__sep" aria-hidden="true" />
      {currentGroup.reports.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.to === '/analytics/sales'}
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
