/**
 * Настройки акций Ozon в интеграции кабинета.
 */

import React from 'react';

export function OzonAutoPromotionsFields({ formData, onChange }) {
  const checked =
    formData.block_ozon_auto_promotions === true ||
    formData.block_ozon_auto_promotions === 'true' ||
    formData.block_ozon_auto_promotions === '1';

  return (
    <fieldset className="integration-ozon-promotions" style={{ marginTop: 16, marginBottom: 8 }}>
      <legend style={{ fontSize: 14, fontWeight: 600 }}>Акции Ozon</legend>
      <div className="form-check" style={{ marginTop: 4 }}>
        <input
          type="checkbox"
          className="form-check-input"
          id="block_ozon_auto_promotions"
          checked={checked}
          onChange={(e) => onChange('block_ozon_auto_promotions', e.target.checked)}
        />
        <label className="form-check-label" htmlFor="block_ozon_auto_promotions">
          Запретить автоматическое добавление товаров в акции
        </label>
      </div>
      <p className="text-muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
        При включении ERM отключает автоучастие в акциях на Ozon и удаляет товары, которые маркетплейс
        добавил автоматически. Проверка выполняется ночью и сразу после сохранения настройки.
      </p>
    </fieldset>
  );
}
