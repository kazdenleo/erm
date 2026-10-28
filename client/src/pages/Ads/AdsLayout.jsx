import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { PageTitle } from '../../components/layout/PageTitle/PageTitle';
import './Ads.css';

export function AdsLayout() {
  return (
    <div className="ads-page">
      <PageTitle
        iconClass="pe-7s-graph1"
        iconBgClass="bg-happy-itmeo"
        title="Реклама"
        subtitle="Статистика ДРР, кампании и автоматизация Ozon / WB / Яндекс.Маркет"
      />
      <nav className="ads-tabs" aria-label="Разделы рекламы">
        <NavLink
          to="/ads"
          end
          className={({ isActive }) =>
            `ads-tabs__link${isActive ? ' ads-tabs__link--active' : ''}`
          }
        >
          Дашборд
        </NavLink>
        <NavLink
          to="/ads/campaigns"
          className={({ isActive }) =>
            `ads-tabs__link${isActive ? ' ads-tabs__link--active' : ''}`
          }
        >
          Кампании
        </NavLink>
        <NavLink
          to="/ads/automation"
          className={({ isActive }) =>
            `ads-tabs__link${isActive ? ' ads-tabs__link--active' : ''}`
          }
        >
          Автоматизация
        </NavLink>
      </nav>
      <Outlet />
    </div>
  );
}

export default AdsLayout;
