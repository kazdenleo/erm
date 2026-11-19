/**
 * Редактирование штрихкода грузоместа.
 * Для QR WB (`$Ts;…;TAS`) в основном поле — номер короба, полный QR — отдельно.
 */

import React, { useEffect, useState } from 'react';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { formatCargoBarcodeLabel, isWbCargoQrPayload } from './fboPackingFormat.js';

export function FboCargoBarcodeEdit({ supplyId, cargo, onPackingChange, onClick }) {
  const [barcode, setBarcode] = useState(cargo.barcode || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [showFullQr, setShowFullQr] = useState(false);

  useEffect(() => {
    setBarcode(cargo.barcode || '');
    setError(null);
    setShowFullQr(false);
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

  const isWbQr = isWbCargoQrPayload(barcode);
  const boxLabel = formatCargoBarcodeLabel(barcode);

  return (
    <div className="fbo-cargo-barcode-edit" onClick={onClick}>
      {isWbQr ? (
        <>
          <label className="fbo-cargo-barcode-edit__field">
            <span className="text-muted small">Короб WB (№ · техкод)</span>
            <input
              type="text"
              className="form-control form-control-sm"
              value={boxLabel}
              readOnly
              title={barcode}
            />
          </label>
          <button
            type="button"
            className="btn btn-link btn-sm px-0 mt-1"
            onClick={(e) => {
              e.stopPropagation();
              setShowFullQr((v) => !v);
            }}
          >
            {showFullQr ? 'Скрыть полный QR' : 'Показать полный QR (для скана)'}
          </button>
          {showFullQr ? (
            <label className="fbo-cargo-barcode-edit__field mt-1">
              <span className="text-muted small">Полный QR `$Ts;…;TAS`</span>
              <input
                type="text"
                className="form-control form-control-sm"
                value={barcode}
                disabled={saving}
                spellCheck={false}
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
          ) : null}
        </>
      ) : (
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
      )}
      {error ? <div className="text-danger small mt-1">{error}</div> : null}
    </div>
  );
}
