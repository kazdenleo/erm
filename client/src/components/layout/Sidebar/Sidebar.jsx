/**
 * Sidebar Component
 * Боковая панель навигации
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../../context/AuthContext.jsx';
import { questionsApi } from '../../../services/questions.api';
import { WAREHOUSE_OPERATION_OPS, warehouseOpFromSearch } from '../../../pages/StockLevels/warehouseTabs.js';

/** Подпункты «Склад»: операции склада (?op=) + закупка */
const stockWarehouseChildren = [
  ...WAREHOUSE_OPERATION_OPS.map((t) => ({
    path: t.to,
    label: t.label,
    iconClass: 'pe-7s-angle-right',
    warehouseOp: t.op,
  })),
  { path: '/stock-levels/purchases', label: '🧾 Закупка', iconClass: 'pe-7s-cart' },
];

const menuItems = [
  { path: '/', label: 'Аналитика', iconClass: 'pe-7s-graph2' },
  { path: '/products', label: 'Товары', iconClass: 'pe-7s-box2' },
  { path: '/orders', label: 'Заказы', iconClass: 'pe-7s-note2' },
  { path: '/questions', label: 'Вопросы', iconClass: 'pe-7s-comment' },
  { path: '/reviews', label: 'Отзывы', iconClass: 'pe-7s-like2' },
  { path: '/shipments', label: 'Поставки FBS', iconClass: 'pe-7s-upload' },
  { path: '/stock-levels/suppliers', label: 'Остатки поставщиков', iconClass: 'pe-7s-truck' },
  {
    path: '/stock-levels/warehouse',
    label: 'Склад',
    iconClass: 'pe-7s-display2',
    children: stockWarehouseChildren,
  },
  { path: '/prices', label: 'Цены', iconClass: 'pe-7s-cash' },
  {
    path: '/settings',
    label: 'Настройки',
    iconClass: 'pe-7s-config',
    children: [
      { path: '/settings', label: 'Общие', iconClass: 'pe-7s-note' },
      { path: '/settings/attributes', label: 'Атрибуты', iconClass: 'pe-7s-ticket' },
      { path: '/settings/labels', label: 'Этикетки', iconClass: 'pe-7s-news-paper' },
      { path: '/settings/users', label: 'Пользователи', iconClass: 'pe-7s-users', adminOnly: true },
      { path: '/organizations', label: 'Организации', iconClass: 'pe-7s-culture' },
      { path: '/warehouses', label: 'Склады', iconClass: 'pe-7s-home' },
      { path: '/suppliers', label: 'Поставщики', iconClass: 'pe-7s-truck' },
      { path: '/categories', label: 'Категории', iconClass: 'pe-7s-folder' },
      { path: '/brands', label: 'Бренды', iconClass: 'pe-7s-star' },
      { path: '/integrations', label: 'Интеграции', iconClass: 'pe-7s-plug' }
    ]
  }
];

export function Sidebar() {
  const location = useLocation();
  const { user, isAdmin, isProfileAdmin, isAccountAdmin } = useAuth();
  const canManageUsers = isAccountAdmin;
  const NONE = '__none__';
  const [questionsNewCount, setQuestionsNewCount] = useState(0);

  const loadQuestionsStats = useCallback(async () => {
    if (user?.profileId == null || user?.profileId === '') {
      setQuestionsNewCount(0);
      return;
    }
    try {
      const { newCount } = await questionsApi.getStats();
      setQuestionsNewCount(typeof newCount === 'number' && Number.isFinite(newCount) ? newCount : 0);
    } catch {
      setQuestionsNewCount(0);
    }
  }, [user?.profileId]);

  useEffect(() => {
    loadQuestionsStats();
    const t = setInterval(loadQuestionsStats, 60000);
    return () => clearInterval(t);
  }, [loadQuestionsStats]);

  useEffect(() => {
    const onRefresh = () => loadQuestionsStats();
    window.addEventListener('questions-stats-refresh', onRefresh);
    return () => window.removeEventListener('questions-stats-refresh', onRefresh);
  }, [loadQuestionsStats]);

  useEffect(() => {
    if (location.pathname === '/questions') loadQuestionsStats();
  }, [location.pathname, loadQuestionsStats]);

  /** Активен ли подпункт (учёт ?op= у /stock-levels/warehouse) */
  const childMatchesLocation = useCallback((sub, loc) => {
    const pathname = loc.pathname;
    const sp = new URLSearchParams(loc.search || '');
    if (sub.warehouseOp != null) {
      const op = warehouseOpFromSearch(sp);
      return pathname === '/stock-levels/warehouse' && op === sub.warehouseOp;
    }
    const base = String(sub.path || '').split('?')[0];
    return pathname === base;
  }, []);

  const findActiveGroup = useCallback((loc) => {
    const path = loc.pathname || '';
    const group = menuItems.find((it) => {
      if (!Array.isArray(it.children) || it.children.length === 0) return false;
      if (path === it.path || (it.path !== '/' && path.startsWith(it.path))) return true;
      return it.children.some((sub) => childMatchesLocation(sub, loc));
    });
    return group?.path ?? null;
  }, [childMatchesLocation]);

  const [openGroup, setOpenGroup] = useState(() => findActiveGroup(location) ?? NONE);

  useEffect(() => {
    const activeGroup = findActiveGroup(location);
    if (!activeGroup) return;
    setOpenGroup((prev) => {
      if (prev === activeGroup) return prev;
      if (prev === NONE) return activeGroup;
      return activeGroup;
    });
  }, [location.pathname, location.search, findActiveGroup, location]);

  const visibleMenu = useMemo(() => {
    const filterChildren = (item) => {
      if (!item.children) return item;
      const children = item.children.filter((sub) => {
        if (sub.profileAdminOnly && (!isProfileAdmin || isAdmin)) return false;
        if (sub.adminOnly && !canManageUsers) return false;
        return true;
      });
      return { ...item, children };
    };
    return menuItems
      .filter((i) => !i.needsProfile || user?.profileId != null)
      .map(filterChildren)
      .filter((i) => !i.children || i.children.length > 0);
  }, [canManageUsers, isProfileAdmin, isAdmin, user?.profileId]);

  const isActive = (path) => location.pathname === path || (path !== '/' && location.pathname.startsWith(path));

  return (
    <div className="app-sidebar sidebar-shadow">
      <div className="app-header__logo">
        <div className="app-brand-text" aria-label="Программа Ирина">Программа Ирина</div>
      </div>

      <div className="scrollbar-sidebar">
        <div className="app-sidebar__inner">
          <ul className="vertical-nav-menu">
            <li className="app-sidebar__heading">ERP</li>

            {visibleMenu.map((item) => {
              const hasChildren = Array.isArray(item.children) && item.children.length > 0;
              const active = hasChildren
                ? item.children.some((sub) => childMatchesLocation(sub, location))
                : isActive(item.path);
              const isOpen = hasChildren && openGroup === item.path;

              if (!hasChildren) {
                const showQBadge = item.path === '/questions' && questionsNewCount > 0;
                const badgeText = questionsNewCount > 99 ? '99+' : String(questionsNewCount);
                return (
                  <li key={item.path}>
                    <Link to={item.path} className={active ? 'mm-active' : ''}>
                      <i className={`metismenu-icon ${item.iconClass}`} />
                      <span className="sidebar-nav-label">{item.label}</span>
                      {showQBadge ? (
                        <span className="sidebar-menu-badge" title="Новых вопросов без ответа">
                          {badgeText}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              }

              return (
                <li key={item.path} className={isOpen ? 'mm-active' : ''}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setOpenGroup((prev) => (prev === item.path ? NONE : item.path));
                    }}
                    aria-expanded={isOpen ? 'true' : 'false'}
                    className={`metismenu-link metismenu-link--toggle ${active ? 'mm-active' : ''}`}
                  >
                    <i className={`metismenu-icon ${item.iconClass}`} />
                    {item.label}
                    <i className="metismenu-state-icon pe-7s-angle-down caret-left" />
                  </button>
                  <ul className={isOpen ? 'mm-show' : ''}>
                    {item.children.map((sub) => {
                      const subActive = childMatchesLocation(sub, location);
                      return (
                        <li key={sub.warehouseOp ?? sub.path}>
                          <Link to={sub.path} className={subActive ? 'mm-active' : ''}>
                            <i className={`metismenu-icon ${sub.iconClass || ''}`} />
                            {sub.label}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}


