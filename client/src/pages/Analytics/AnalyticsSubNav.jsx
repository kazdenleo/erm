/**
 * Поднавигация раздела «Аналитика»
 */

import React from 'react';
import { NavLink } from 'react-router-dom';
import './AnalyticsSubNav.css';

const TABS = [
  { to: '/analytics/sales', label: 'Продажи FBS', end: true },
  { to: '/analytics/fbo-sales', label: 'Продажи FBO' },
  { to: '/analytics/categories', label: 'По категориям' },
  { to: '/analytics/abc', label: 'ABC' },
  { to: '/analytics/dynamics', label: 'Динамика' },
  { to: '/analytics/turnover', label: 'Оборачиваемость' },
  { to: '/analytics/card-work', label: 'Работа с карточками' },
  { to: '/analytics/hypotheses', label: 'Гипотезы' },
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
