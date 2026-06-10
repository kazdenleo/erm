/**
 * Переключатель типа грузоместа: короб / паллета.
 */

import React, { useState } from 'react';
import { fboSuppliesApi } from '../../services/fboSupplies.api';

export function FboCargoUnitKind({ supplyId, cargo, onPackingChange, onClick }) {
  const kind = cargo.cargoKind === 'pallet' ? 'pallet' : 'box';
  const [saving, setSaving] = useState(false);

  const setKind = async (next) => {
    if (next === kind || saving) return;
    setSaving(true);
    try {
      const data = await fboSuppliesApi.updateCargoUnit(supplyId, cargo.id, { cargoKind: next });
      if (data?.packing) onPackingChange?.(data.packing);
    } finally {
      setSaving(false);
    }
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
    </div>
  );
}
