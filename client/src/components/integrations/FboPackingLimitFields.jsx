/**
 * Лимиты веса короба/паллеты для сборки FBO в настройках маркетплейса.
 */

import React from 'react';

export function FboPackingLimitFields({ formData, onChange }) {
  const handle = (field, raw) => {
    const v = raw === '' ? null : raw;
    onChange(field, v);
  };

  return (
    <fieldset className="integration-fbo-limits" style={{ marginTop: 16, marginBottom: 8 }}>
      <legend style={{ fontSize: 14, fontWeight: 600 }}>Сборка FBO</legend>
      <p className="text-muted" style={{ fontSize: 12, margin: '0 0 10px' }}>
        При превышении веса грузоместа на вкладке «Сборка» поставки показывается предупреждение.
      </p>
      <div className="field">
        <label className="label">Максимальный вес короба, кг</label>
        <input
          type="number"
          className="input"
          min="0"
          step="0.1"
          value={formData.fbo_max_box_weight_kg ?? ''}
          onChange={(e) => handle('fbo_max_box_weight_kg', e.target.value)}
          placeholder="Например, 25"
        />
      </div>
      <div className="field">
        <label className="label">Максимальный вес паллеты, кг</label>
        <input
          type="number"
          className="input"
          min="0"
          step="0.1"
          value={formData.fbo_max_pallet_weight_kg ?? ''}
          onChange={(e) => handle('fbo_max_pallet_weight_kg', e.target.value)}
          placeholder="Например, 500"
        />
      </div>
    </fieldset>
  );
}
