/**
 * Закрепление товаров за ячейкой.
 */

import React, { useState } from 'react';
import { Modal } from '../../components/common/Modal/Modal';
import { addressStorageApi, addressStorageError } from '../../services/addressStorage.api';
import { ProductPicker } from './ProductPicker';

export function AssignProductModal({ warehouseId, location, onClose, onChanged }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const assigned = (location?.products || []).filter((p) => p.assigned);
  const placedOnly = (location?.products || []).filter((p) => !p.assigned);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged?.();
    } catch (e) {
      setError(addressStorageError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={Boolean(location)} onClose={onClose} title={`Ячейка ${location?.code || ''}`} size="medium">
      <p className="muted-hint mt-0">
        Закреплённый товар всегда кладут в эту ячейку; у товара на складе может быть одна закреплённая ячейка —
        при закреплении здесь прежняя заменяется.
      </p>
      <ProductPicker
        warehouseId={warehouseId}
        autoFocus
        placeholder="Найти товар, чтобы закрепить за ячейкой"
        onPick={(p) => {
          if (
            p.assignedLocationCode &&
            p.assignedLocationId !== location.id &&
            !window.confirm(`Товар закреплён за ${p.assignedLocationCode}. Перезакрепить за ${location.code}?`)
          ) {
            return;
          }
          void run(() => addressStorageApi.assignProduct(warehouseId, p.id, location.id));
        }}
      />
      {error ? <div className="alert alert-danger py-2 mt-2">{error}</div> : null}
      <h5 className="address-modal__subtitle">Закреплены</h5>
      {assigned.length === 0 ? <p className="muted-hint">Нет</p> : null}
      <ul className="address-modal__list">
        {assigned.map((p) => (
          <li key={p.productId}>
            📌 <code>{p.sku}</code> {p.name}
            {p.quantity ? <span className="muted-hint"> — {p.quantity} шт</span> : null}
            <button
              type="button"
              className="btn btn-link btn-sm text-danger"
              disabled={busy}
              onClick={() => run(() => addressStorageApi.assignProduct(warehouseId, p.productId, null))}
            >
              открепить
            </button>
          </li>
        ))}
      </ul>
      {placedOnly.length ? (
        <>
          <h5 className="address-modal__subtitle">Лежат без закрепления</h5>
          <ul className="address-modal__list">
            {placedOnly.map((p) => (
              <li key={p.productId}>
                <code>{p.sku}</code> {p.name} <span className="muted-hint">— {p.quantity} шт</span>
                <button
                  type="button"
                  className="btn btn-link btn-sm"
                  disabled={busy}
                  onClick={() => run(() => addressStorageApi.assignProduct(warehouseId, p.productId, location.id))}
                >
                  закрепить
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Modal>
  );
}
