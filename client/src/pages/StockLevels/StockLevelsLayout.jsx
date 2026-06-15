/**
 * Layout раздела склада.
 * Переключение подразделов — в боковом меню (Склад → подпункты).
 */

import React from 'react';
import { Outlet } from 'react-router-dom';
import './StockLevelsLayout.css';

export function StockLevelsLayout() {
  return (
    <div className="card stock-levels-layout">
      <h1 className="title">📦 Склад</h1>
      <p className="subtitle">Остатки на собственном складе, закупки, поставки FBO и приёмки</p>

      <div className="stock-levels-content">
        <Outlet />
      </div>
    </div>
  );
}
