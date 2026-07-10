/**
 * Поднавигация раздела «Аналитика»
 */

import React from 'react';
import { NavLink } from 'react-router-dom';
import './AnalyticsSubNav.css';

const TABS = [
  { to: '/analytics/sales', label: 'Продажи FBS', end: true },
  { to: '/analytics/fbo-sales', label: 'Продажи FBO' },
];

export function AnalyticsSubNav() {
  return (
    <nav className="analytics-subnav" aria-label="Раздел аналитики">
      {TABS.map((tab) => (
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
