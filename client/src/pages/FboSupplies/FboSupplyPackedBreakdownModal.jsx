/**
 * Распределение упакованного товара по грузоместам.
 */

import React from 'react';
import { Modal } from '../../components/common/Modal/Modal';
import { Button } from '../../components/common/Button/Button';

export function FboSupplyPackedBreakdownModal({ isOpen, item, onClose }) {
  if (!isOpen || !item) return null;

  const name = item.productName || item.name || '—';
  const sku = item.sku ? ` · ${item.sku}` : '';
  const byCargo = item.byCargo || item.stat?.byCargo || [];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Упаковано по грузоместам" size="medium">
      <p style={{ marginBottom: 12 }}>
        <strong>{name}</strong>
        {sku}
        <br />
        <span className="text-muted" style={{ fontSize: 13 }}>
          Упаковано {item.packed ?? item.stat?.packed ?? 0} из {item.planned ?? item.stat?.planned ?? item.quantity ?? 0}
        </span>
      </p>
      {byCargo.length === 0 ? (
        <p className="text-muted">Товар ещё не отсканирован в грузоместа.</p>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Грузоместо (штрихкод)</th>
                <th style={{ width: 100 }}>Кол-во</th>
              </tr>
            </thead>
            <tbody>
              {byCargo.map((row) => (
                <tr key={`${row.cargoUnitId}-${row.quantity}`}>
                  <td>{row.cargoBarcode || `№ ${row.cargoUnitId}`}</td>
                  <td>{row.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="d-flex justify-content-end mt-3">
        <Button variant="secondary" onClick={onClose}>
          Закрыть
        </Button>
      </div>
    </Modal>
  );
}
