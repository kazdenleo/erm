/**
 * Переключатель типа грузоместа: короб / паллета и вес тары паллеты.
 */

import React, { useEffect, useState } from 'react';
import { fboSuppliesApi } from '../../services/fboSupplies.api';

function formatTareInput(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '';
}

export function FboCargoUnitKind({ supplyId, cargo, onPackingChange, onClick }) {
  const kind = cargo.cargoKind === 'pallet' ? 'pallet' : 'box';
  const [saving, setSaving] = useState(false);
  const [tareKg, setTareKg] = useState(formatTareInput(cargo.palletTareWeightKg));

  useEffect(() => {
    setTareKg(formatTareInput(cargo.palletTareWeightKg));
  }, [cargo.id, cargo.palletTareWeightKg, cargo.cargoKind]);

  const patchCargo = async (patch) => {
    setSaving(true);
    try {
      const data = await fboSuppliesApi.updateCargoUnit(supplyId, cargo.id, patch);
      if (data?.packing) onPackingChange?.(data.packing);
    } finally {
      setSaving(false);
    }
  };

  const setKind = async (next) => {
    if (next === kind || saving) return;
    await patchCargo({ cargoKind: next });
  };

  const saveTare = async () => {
    if (saving || kind !== 'pallet') return;
    const raw = tareKg.trim();
    const current = formatTareInput(cargo.palletTareWeightKg);
    if (raw === current || (raw === '' && current === '')) return;
    await patchCargo({ palletTareWeightKg: raw === '' ? null : raw });
  };

  return (
    <div className="fbo-cargo-kind" onClick={onClick}>
      <span className="fbo-cargo-kind__label">Тип:</span>
      <div className="btn-group btn-group-sm" role="group" aria-label="Тип грузоместа">
        <button
          type="button"
          className={`btn btn-outline-secondary${kind === 'box' ? ' active' : ''}`}
          disabled={saving}
          onClick={(e) => {
            e.stopPropagation();
            setKind('box');
          }}
        >
          Короб
        </button>
        <button
          type="button"
          className={`btn btn-outline-secondary${kind === 'pallet' ? ' active' : ''}`}
          disabled={saving}
          onClick={(e) => {
            e.stopPropagation();
            setKind('pallet');
          }}
        >
          Паллета
        </button>
      </div>
      {kind === 'pallet' ? (
        <label className="fbo-cargo-kind__tare" onClick={(e) => e.stopPropagation()}>
          <span>Вес паллеты, кг</span>
          <input
            type="number"
            className="form-control form-control-sm"
            min="0"
            step="0.1"
            disabled={saving}
            placeholder="Тара"
            value={tareKg}
            onChange={(e) => setTareKg(e.target.value)}
            onBlur={saveTare}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
          />
        </label>
      ) : null}
    </div>
  );
}
