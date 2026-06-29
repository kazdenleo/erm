/**
 * Layout раздела склада.
 * Переключение подразделов — в боковом меню (Склад → подпункты).
 */

import React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { StockSectionHeader } from './StockSectionHeader';
import { resolveStockSectionHeader } from './stockSectionHeaders';
import './StockLevelsLayout.css';

export function StockLevelsLayout() {
  const location = useLocation();
  const sectionHeader = resolveStockSectionHeader(location.pathname, location.search);

  return (
    <div className="card stock-levels-layout">
      {sectionHeader ? (
        <StockSectionHeader title={sectionHeader.title} subtitle={sectionHeader.subtitle} />
      ) : null}
      <div className="stock-levels-content">
        <Outlet />
      </div>
    </div>
  );
}
