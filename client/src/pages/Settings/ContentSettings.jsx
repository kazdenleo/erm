/**
 * Настройки → Контент: Rich-контент карточек и видеообложки Ozon.
 */

import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import './ContentSettings.css';

export function ContentSettingsLayout() {
  return (
    <div className="content-settings">
      <h1 className="title">Контент</h1>
      <p className="content-settings-subtitle">
        Шаблоны Rich-контента карточек и видеообложки Ozon
      </p>
      <nav className="content-settings-tabs" aria-label="Разделы контента">
        <NavLink to="/settings/content/rich-content">Rich-контент</NavLink>
        <NavLink to="/settings/content/video-cover">Видеообложки</NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
