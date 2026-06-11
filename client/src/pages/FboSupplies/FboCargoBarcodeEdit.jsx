/**
 * Редактирование штрихкода грузоместа.
 */

import React, { useEffect, useState } from 'react';
import { fboSuppliesApi } from '../../services/fboSupplies.api';

export function FboCargoBarcodeEdit({ supplyId, cargo, onPackingChange, onClick }) {
  const [barcode, setBarcode] = useState(cargo.barcode || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setBarcode(cargo.barcode || '');
    setError(null);
  }, [cargo.id, cargo.barcode]);

  const save = async () => {
    const next = (barcode || '').trim();
    const prev = (cargo.barcode || '').trim();
    if (next === prev || saving) return;
    if (!next) {
      setError('Штрихкод не может быть пустым');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const data = await fboSuppliesApi.updateCargoUnit(supplyId, cargo.id, { barcode: next });
      if (data?.packing) onPackingChange?.(data.packing);
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Не удалось сохранить');
      setBarcode(cargo.barcode || '');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fbo-cargo-barcode-edit" onClick={onClick}>
      <label className="fbo-cargo-barcode-edit__field">
        <span className="text-muted small">ШК грузоместа</span>
        <input
          type="text"
          className="form-control form-control-sm"
          value={barcode}
          disabled={saving}
          onChange={(e) => {
            setBarcode(e.target.value);
            setError(null);
          }}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
      </label>
      {error ? <div className="text-danger small mt-1">{error}</div> : null}
    </div>
  );
}
