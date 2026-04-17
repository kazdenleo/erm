/**
 * Layout раздела склада и остатков у поставщиков.
 * Переключение подразделов склада — в боковом меню (Склад → подпункты).
 */

import React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import './StockLevelsLayout.css';

export function StockLevelsLayout() {
  const { pathname } = useLocation();
  const isSuppliersSection = pathname === '/stock-levels/suppliers' || pathname.startsWith('/stock-levels/suppliers/');

  return (
    <div className="card stock-levels-layout">
      <h1 className="title">{isSuppliersSection ? '📊 Остатки поставщиков' : '📦 Склад'}</h1>
      <p className="subtitle">
        {isSuppliersSection
          ? 'Остатки товаров у поставщиков'
          : 'Остатки на собственном складе, закупки и приёмки'}
      </p>

      <div className="stock-levels-content">
        <Outlet />
      </div>
    </div>
  );
}
