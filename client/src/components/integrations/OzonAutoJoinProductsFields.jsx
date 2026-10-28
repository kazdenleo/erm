/**
 * Автообъединение карточек Ozon (Join SKU / атрибут 9048) в интеграции кабинета.
 */

import React from 'react';

export function OzonAutoJoinProductsFields({ formData, onChange }) {
  const checked =
    formData.ozon_auto_join_products === true ||
    formData.ozon_auto_join_products === 'true' ||
    formData.ozon_auto_join_products === '1';

  return (
    <fieldset className="integration-ozon-join-products" style={{ marginTop: 16, marginBottom: 8 }}>
      <legend style={{ fontSize: 14, fontWeight: 600 }}>Объединение карточек</legend>
      <div className="form-check" style={{ marginTop: 4 }}>
        <input
          type="checkbox"
          className="form-check-input"
          id="ozon_auto_join_products"
          checked={checked}
          onChange={(e) => onChange('ozon_auto_join_products', e.target.checked)}
        />
        <label className="form-check-label" htmlFor="ozon_auto_join_products">
          Объединять товары автоматически
        </label>
      </div>
      <p className="text-muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
        Товары одного типа и бренда получают общий «Артикул для объединения» (атрибут 9048) в кабинете
        Ozon. Прогон каждые 12 часов и сразу после сохранения настройки.
      </p>
    </fieldset>
  );
}
