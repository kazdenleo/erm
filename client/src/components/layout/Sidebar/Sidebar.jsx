/**
 * Sidebar Component
 * Боковая панель навигации
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../../context/AuthContext.jsx';

const menuItems = [
  { path: '/', label: 'Аналитика', iconClass: 'pe-7s-graph2' },
  { path: '/products', label: 'Товары', iconClass: 'pe-7s-box2' },
  { path: '/orders', label: 'Заказы', iconClass: 'pe-7s-note2' },
  { path: '/assembly', label: 'Сборка', iconClass: 'pe-7s-tools' },
  { path: '/shipments', label: 'Поставки', iconClass: 'pe-7s-upload' },
  {
    path: '/stock-levels',
    label: 'Остатки',
    iconClass: 'pe-7s-display2',
    children: [
      { path: '/stock-levels/suppliers', label: 'Остатки поставщиков', iconClass: 'pe-7s-truck' },
      {
        path: '/stock-levels/warehouse',
        label: 'Склад',
        iconClass: 'pe-7s-home',
        activePaths: ['/stock-levels/warehouse', '/stock-levels/purchases', '/stock-levels/problems'],
      },
    ],
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
  const findActiveGroup = (pathname) => {
    const path = pathname || '';
    const group = menuItems.find((it) => {
      if (!Array.isArray(it.children) || it.children.length === 0) return false;
      if (path === it.path || (it.path !== '/' && path.startsWith(it.path))) return true;
      return it.children.some((sub) => path === sub.path || (sub.path !== '/' && path.startsWith(sub.path)));
    });
    return group?.path ?? null;
  };

  const [openGroup, setOpenGroup] = useState(() => findActiveGroup(location.pathname) ?? NONE);

  useEffect(() => {
    const activeGroup = findActiveGroup(location.pathname);
    if (!activeGroup) return;
    setOpenGroup((prev) => {
      if (prev === activeGroup) return prev;
      // если пользователь ранее свернул все группы — при навигации откроем активную
      if (prev === NONE) return activeGroup;
      // иначе всегда держим раскрытой группу активного раздела
      return activeGroup;
    });
  }, [location.pathname]);

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
              const active = isActive(item.path);
              const hasChildren = Array.isArray(item.children) && item.children.length > 0;
              const isOpen = hasChildren && openGroup === item.path;

              if (!hasChildren) {
                return (
                  <li key={item.path}>
                    <Link to={item.path} className={active ? 'mm-active' : ''}>
                      <i className={`metismenu-icon ${item.iconClass}`} />
                      {item.label}
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
                    className={`metismenu-link ${active ? 'mm-active' : ''}`}
                    aria-expanded={isOpen ? 'true' : 'false'}
                    style={{ background: 'none', border: 'none', width: '100%', textAlign: 'left', cursor: 'pointer', padding: 0, font: 'inherit', color: 'inherit' }}
                  >
                    <i className={`metismenu-icon ${item.iconClass}`} />
                    {item.label}
                    <i className="metismenu-state-icon pe-7s-angle-down caret-left" />
                  </button>
                  <ul className={isOpen ? 'mm-show' : ''}>
                    {item.children.map((sub) => {
                      const subPaths = sub.activePaths || [sub.path];
                      const subActive = subPaths.some((p) => location.pathname === p);
                      return (
                        <li key={sub.path}>
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


