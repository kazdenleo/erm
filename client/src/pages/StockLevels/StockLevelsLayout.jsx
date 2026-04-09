/**
 * Layout раздела "Остатки": у поставщиков — только контент без вкладок;
 * у склада — единая полоса вкладок: операции склада + закупка + проблемы.
 */

import React, { useMemo } from 'react';
import { Outlet, NavLink, useLocation, Link } from 'react-router-dom';
import { WAREHOUSE_OPERATION_OPS, warehouseOpFromSearch } from './warehouseTabs';
import './StockLevelsLayout.css';

export function StockLevelsLayout() {
  const { pathname, search } = useLocation();
  const isSuppliersSection = pathname === '/stock-levels/suppliers' || pathname.startsWith('/stock-levels/suppliers/');
  const showWarehouseTabs = !isSuppliersSection;
  const warehouseOp = useMemo(
    () => warehouseOpFromSearch(new URLSearchParams(search || '')),
    [search]
  );

  return (
    <div className="card stock-levels-layout">
      <h1 className="title">📊 Остатки</h1>
      <p className="subtitle">Остатки товаров у поставщиков и на собственном складе</p>

      {showWarehouseTabs ? (
        <nav className="stock-levels-subnav stock-levels-subnav--wrap" aria-label="Подразделы склада">
          {WAREHOUSE_OPERATION_OPS.map(({ op, label, to }) => {
            const active = pathname === '/stock-levels/warehouse' && warehouseOp === op;
            return (
              <Link key={op} to={to} className={`stock-levels-tab${active ? ' active' : ''}`}>
                {label}
              </Link>
            );
          })}
          <NavLink
            to="/stock-levels/purchases"
            className={({ isActive }) => `stock-levels-tab ${isActive ? 'active' : ''}`}
          >
            🧾 Закупка
          </NavLink>
          <NavLink
            to="/stock-levels/problems"
            className={({ isActive }) => `stock-levels-tab ${isActive ? 'active' : ''}`}
          >
            ⚠️ Проблемы
          </NavLink>
        </nav>
      ) : null}

      <div className="stock-levels-content">
        <Outlet />
      </div>
    </div>
  );
}
