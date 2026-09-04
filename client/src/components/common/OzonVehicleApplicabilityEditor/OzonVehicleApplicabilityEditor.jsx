import React from 'react';
import { Button } from '../Button/Button';
import { emptyVehicleRow } from '../../../utils/ozonComplexAttributes.js';
import './OzonVehicleApplicabilityEditor.css';

export function OzonVehicleApplicabilityEditor({
  rows = [],
  onChange,
  disabled = false,
}) {
  const list = rows.length ? rows : [emptyVehicleRow()];

  const patch = (index, key, value) => {
    const next = list.map((r, i) => (i === index ? { ...r, [key]: value } : { ...r }));
    onChange?.(next);
  };

  const add = () => onChange?.([...list, emptyVehicleRow()]);
  const remove = (index) => {
    const next = list.filter((_, i) => i !== index);
    onChange?.(next.length ? next : [emptyVehicleRow()]);
  };

  return (
    <div className="ozon-vehicle-editor">
      <div className="d-flex justify-content-between align-items-center">
        <strong style={{ fontSize: 13 }}>Автомобили Ozon (марка / модель / модификация)</strong>
        <Button type="button" variant="secondary" size="small" disabled={disabled} onClick={add}>
          + Автомобиль
        </Button>
      </div>
      {list.map((row, i) => (
        <div key={i} className="ozon-vehicle-editor__row">
          <label>
            Марка
            <input
              className="form-control form-control-sm"
              value={row.mark}
              disabled={disabled}
              onChange={(e) => patch(i, 'mark', e.target.value)}
            />
          </label>
          <label>
            Модель
            <input
              className="form-control form-control-sm"
              value={row.model}
              disabled={disabled}
              onChange={(e) => patch(i, 'model', e.target.value)}
            />
          </label>
          <label>
            Модификация
            <input
              className="form-control form-control-sm"
              value={row.modification}
              disabled={disabled}
              onChange={(e) => patch(i, 'modification', e.target.value)}
            />
          </label>
          <Button
            type="button"
            variant="secondary"
            size="small"
            disabled={disabled || list.length <= 1}
            onClick={() => remove(i)}
          >
            ×
          </Button>
        </div>
      ))}
      <p className="text-muted small mb-0">
        Несколько строк — как в кабинете Ozon. При отправке карточки уйдёт в complex_attributes.
      </p>
    </div>
  );
}

export default OzonVehicleApplicabilityEditor;
