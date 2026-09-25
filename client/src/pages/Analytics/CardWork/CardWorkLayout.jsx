/**
 * Layout «Работа с карточками»: вкладки Очередь / Гипотезы.
 */

import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import './CardWork.css';

export function CardWorkLayout() {
  return (
    <div className="sales-analytics card-work-page">
      <PageTitle
        iconClass="pe-7s-note2"
        iconBgClass="bg-mean-fruit"
        title="Работа с карточками"
        subtitle="Очередь карточек и гипотезы по уже загруженным отчётам"
      />
      <nav className="card-work-tabs" aria-label="Разделы работы с карточками">
        <NavLink
          to="/card-work"
          end
          className={({ isActive }) =>
            `card-work-tabs__link${isActive ? ' card-work-tabs__link--active' : ''}`
          }
        >
          Работа с карточками
        </NavLink>
        <NavLink
          to="/card-work/hypotheses"
          className={({ isActive }) =>
            `card-work-tabs__link${isActive ? ' card-work-tabs__link--active' : ''}`
          }
        >
          Гипотезы
        </NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
