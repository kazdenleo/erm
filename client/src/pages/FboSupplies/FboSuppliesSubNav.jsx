/**
 * Поднавигация раздела «Поставки FBO»
 */

import React from 'react';
import { NavLink } from 'react-router-dom';
import './FboSuppliesSubNav.css';

const TABS = [
  { to: '/stock-levels/fbo-supplies', label: 'Поставки', end: true },
  { to: '/stock-levels/fbo-supplies/forecasting', label: 'Прогнозирование поставок', end: false },
];

export function FboSuppliesSubNav() {
  return (
    <nav className="fbo-supplies-subnav" aria-label="Раздел поставок FBO">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            `fbo-supplies-subnav__link${isActive ? ' fbo-supplies-subnav__link--active' : ''}`
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
