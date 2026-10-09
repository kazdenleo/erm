/**
 * Вспомогательные виджеты главной: быстрые ссылки и личная заметка.
 */

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

export const QUICK_LINKS = [
  { id: 'orders', to: '/orders', label: 'Заказы', icon: 'pe-7s-note2', sectionKey: 'orders' },
  { id: 'fbo', to: '/stock-levels/fbo-supplies', label: 'Поставки FBO', icon: 'pe-7s-box2', sectionKey: 'fbo', requiresFbo: true },
  { id: 'stock', to: '/stock-levels/warehouse', label: 'Остатки', icon: 'pe-7s-display2', sectionKey: 'warehouse_stock' },
  { id: 'purchases', to: '/stock-levels/purchases', label: 'Закупка', icon: 'pe-7s-cart', sectionKey: 'warehouse_purchases' },
  { id: 'receipts', to: '/stock-levels/warehouse?op=receipts_list', label: 'Приёмка', icon: 'pe-7s-download', sectionKey: 'warehouse_receipts' },
  { id: 'returns', to: '/stock-levels/warehouse?op=return_customer', label: 'Возвраты от клиентов', icon: 'pe-7s-back', sectionKey: 'warehouse_return_customer' },
  { id: 'inventory', to: '/stock-levels/warehouse?op=inventory', label: 'Инвентаризация', icon: 'pe-7s-note', sectionKey: 'warehouse_inventory' },
  { id: 'products', to: '/products', label: 'Товары', icon: 'pe-7s-box1', sectionKey: 'products' },
  { id: 'card_work', to: '/card-work', label: 'Работа с карточками', icon: 'pe-7s-pen', sectionKey: 'card_work' },
  { id: 'prices', to: '/prices', label: 'Цены', icon: 'pe-7s-cash', sectionKey: 'prices' },
  { id: 'questions', to: '/questions', label: 'Вопросы', icon: 'pe-7s-comment', sectionKey: 'questions' },
  { id: 'reviews', to: '/reviews', label: 'Отзывы', icon: 'pe-7s-like2', sectionKey: 'reviews' },
  { id: 'tasks', to: '/tasks', label: 'Задачи', icon: 'pe-7s-check', sectionKey: 'tasks' },
  { id: 'sales', to: '/analytics/sales', label: 'Продажи FBS', icon: 'pe-7s-graph2', sectionKey: 'analytics_sales' },
  { id: 'fbo_sales', to: '/analytics/fbo-sales', label: 'Продажи FBO', icon: 'pe-7s-graph1', sectionKey: 'analytics_sales', requiresFbo: true },
  { id: 'abc', to: '/analytics/abc', label: 'ABC-анализ', icon: 'pe-7s-graph3', sectionKey: 'analytics_sales' },
  { id: 'lost', to: '/analytics/lost-revenue', label: 'Упущенная выручка', icon: 'pe-7s-attention', sectionKey: 'analytics_sales' },
  { id: 'employees', to: '/analytics/employees', label: 'Сотрудники', icon: 'pe-7s-users', sectionKey: 'analytics_sales', adminOnly: true },
  { id: 'pnl', to: '/analytics/pnl', label: 'ОПиУ', icon: 'pe-7s-calculator', sectionKey: 'analytics_sales', adminOnly: true },
  { id: 'integrations', to: '/integrations', label: 'Интеграции', icon: 'pe-7s-plug', sectionKey: 'integrations' },
  { id: 'settings', to: '/settings', label: 'Настройки', icon: 'pe-7s-config', sectionKey: 'settings_general' },
];

export const DEFAULT_QUICK_LINKS = ['orders', 'fbo', 'receipts', 'products', 'sales', 'card_work'];

export function QuickLinksWidget({ settings, canUse }) {
  const ids = Array.isArray(settings?.links) ? settings.links : DEFAULT_QUICK_LINKS;
  const links = ids.map((id) => QUICK_LINKS.find((l) => l.id === id)).filter((l) => l && canUse(l));
  return (
    <div className="card mb-0 h-100">
      <div className="card-header">
        <div className="card-header-title mb-0">
          <i className="header-icon pe-7s-star icon-gradient bg-mean-fruit me-2" />
          Быстрый доступ
        </div>
      </div>
      <div className="card-body">
        {links.length === 0 ? (
          <div className="text-muted small">Выберите разделы в настройках виджетов.</div>
        ) : (
          <div className="home-quick-links">
            {links.map((l) => (
              <Link key={l.id} to={l.to} className="home-quick-link">
                <i className={`${l.icon} home-quick-link__icon`} />
                <span>{l.label}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function QuickLinksSettings({ settings, onChange, canUse }) {
  const ids = Array.isArray(settings?.links) ? settings.links : DEFAULT_QUICK_LINKS;
  const toggle = (id) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    onChange({ ...settings, links: next });
  };
  return (
    <div className="home-widgets-editor__links">
      {QUICK_LINKS.filter(canUse).map((l) => (
        <label key={l.id} className="form-check form-check-inline mb-1">
          <input className="form-check-input" type="checkbox" checked={ids.includes(l.id)} onChange={() => toggle(l.id)} />
          <span className="form-check-label">{l.label}</span>
        </label>
      ))}
    </div>
  );
}

const NOTE_MAX = 2000;

export function NoteWidget({ settings, onSettingsChange }) {
  const saved = typeof settings?.text === 'string' ? settings.text : '';
  const [text, setText] = useState(saved);
  useEffect(() => setText(saved), [saved]);

  const commit = () => {
    if (text !== saved) onSettingsChange({ ...settings, text: text.slice(0, NOTE_MAX) });
  };

  return (
    <div className="card mb-0 h-100">
      <div className="card-header">
        <div className="card-header-title mb-0">
          <i className="header-icon pe-7s-note icon-gradient bg-mean-fruit me-2" />
          {settings?.title || 'Заметка'}
        </div>
      </div>
      <div className="card-body">
        <textarea
          className="form-control home-note-textarea"
          value={text}
          maxLength={NOTE_MAX}
          placeholder="Личная заметка: планы на день, напоминания… Сохраняется автоматически."
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
        />
      </div>
    </div>
  );
}
