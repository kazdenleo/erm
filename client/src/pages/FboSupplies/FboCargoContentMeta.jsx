/**
 * Зона размещения (Ozon) и срок годности для строки в грузоместе.
 */

import React, { useEffect, useState } from 'react';
import { fboSuppliesApi } from '../../services/fboSupplies.api';

function toDateInput(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export function FboCargoContentMeta({
  supplyId,
  line,
  marketplace,
  onPackingChange,
  variant = 'block',
  showZone = true,
  showExpiry = true,
}) {
  const isOzon = marketplace !== 'wb';
  const [zone, setZone] = useState(line.placementZone || '');
  const [expiry, setExpiry] = useState(toDateInput(line.expiresAt));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setZone(line.placementZone || '');
    setExpiry(toDateInput(line.expiresAt));
  }, [line.id, line.placementZone, line.expiresAt]);

  const save = async () => {
    setSaving(true);
    try {
      const data = await fboSuppliesApi.updatePackingContent(supplyId, line.id, {
        placementZone: zone,
        expiresAt: expiry || null,
      });
      if (data?.packing) onPackingChange?.(data.packing);
    } catch {
      /* parent may show errors elsewhere */
    } finally {
      setSaving(false);
    }
  };

  if (variant === 'inline') {
    return (
      <div className="fbo-cargo-line-meta fbo-cargo-line-meta--inline" onClick={(e) => e.stopPropagation()}>
        {isOzon && showZone ? (
          <input
            type="text"
            className="form-control form-control-sm"
            value={zone}
            disabled={saving}
            placeholder="Код зоны"
            title="Код зоны для выгрузки Ozon"
            onChange={(e) => setZone(e.target.value)}
            onBlur={save}
          />
        ) : null}
        {showExpiry ? (
          <input
            type="date"
            className="form-control form-control-sm"
            value={expiry}
            disabled={saving}
            title="Срок годности"
            onChange={(e) => setExpiry(e.target.value)}
            onBlur={save}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="fbo-cargo-line-meta" onClick={(e) => e.stopPropagation()}>
      {isOzon ? (
        <label className="fbo-cargo-line-meta__field">
          <span>Зона</span>
          <input
            type="text"
            className="form-control form-control-sm"
            value={zone}
            disabled={saving}
            placeholder="Размещение"
            onChange={(e) => setZone(e.target.value)}
            onBlur={save}
          />
        </label>
      ) : null}
      <label className="fbo-cargo-line-meta__field">
        <span>СГ до</span>
        <input
          type="date"
          className="form-control form-control-sm"
          value={expiry}
          disabled={saving}
          onChange={(e) => setExpiry(e.target.value)}
          onBlur={save}
        />
      </label>
    </div>
  );
}
