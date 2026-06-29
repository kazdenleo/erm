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
      <div className="stock-levels-content">
        <Outlet />
      </div>
    </div>
  );
}
