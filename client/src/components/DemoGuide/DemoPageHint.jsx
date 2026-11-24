/**
 * Контекстная подсказка на страницах (товары / цены / интеграции).
 */
import React from 'react';
import { useLocation } from 'react-router-dom';
import { useDemoUxContext } from '../../context/DemoUxContext.jsx';
import './DemoGuide.css';

const HINTS = [
  {
    key: 'hint_products',
    match: (p) => p === '/products' || p.startsWith('/products/'),
    text: 'В каталоге есть DEMO-001 и DEMO-002 — откройте карточку, чтобы увидеть себестоимость и остаток.',
  },
  {
    key: 'hint_prices',
    match: (p) => p.startsWith('/prices'),
    text: 'Здесь минимальные цены по Ozon / WB / Я.Маркету для демо-товаров. Можно менять стратегию и смотреть маржу.',
  },
  {
    key: 'hint_integrations',
    match: (p) => p.startsWith('/integrations'),
    text: 'Подключите кабинет маркетплейса по API-ключу — после этого подтянутся заказы и остатки.',
  },
];

export function DemoPageHint() {
  const location = useLocation();
  const { ux, hintVisible, dismissHint } = useDemoUxContext();
  if (!ux?.isDemo) return null;

  const path = location.pathname || '';
  const hit = HINTS.find((h) => h.match(path) && hintVisible(h.key));
  if (!hit) return null;

  return (
    <div className="demo-page-hint mx-3 mt-2 mb-0" role="status">
      <span>{hit.text}</span>
      <button type="button" className="demo-guide-dismiss" onClick={() => dismissHint(hit.key)}>
        Понятно
      </button>
    </div>
  );
}

export default DemoPageHint;
