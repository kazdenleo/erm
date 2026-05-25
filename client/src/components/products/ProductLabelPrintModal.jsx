/**
 * Диалог печати этикетки товара с выбором количества копий.
 */

import React, { useEffect, useState } from 'react';
import { Modal } from '../common/Modal/Modal';
import { Button } from '../common/Button/Button';

const MAX_COPIES = 99;

function parseCopies(value) {
  const n = parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_COPIES, n);
}

export function ProductLabelPrintModal({
  isOpen,
  product,
  onClose,
  onPrint,
  printing = false,
  error = '',
  defaultCopies = 1,
}) {
  const [copies, setCopies] = useState('1');

  useEffect(() => {
    if (isOpen) {
      const n = parseCopies(defaultCopies);
      setCopies(String(n));
    }
  }, [isOpen, product?.id, defaultCopies]);

  if (!isOpen || !product) return null;

  const categoryId = product.user_category_id ?? product.userCategoryId ?? product.categoryId;
  const canPrint = Boolean(categoryId);
  const name = product.name || product.sku || `Товар #${product.id}`;
  const sku = product.sku ? String(product.sku) : '';

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!canPrint || printing) return;
    onPrint(parseCopies(copies));
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Печать этикетки" size="small">
      <form onSubmit={handleSubmit}>
        <p className="product-label-print-modal__product" style={{ marginBottom: 12 }}>
          <strong>{name}</strong>
          {sku ? (
            <>
              <br />
              <span className="text-muted" style={{ fontSize: 13 }}>
                SKU: {sku}
              </span>
            </>
          ) : null}
        </p>

        {!canPrint ? (
          <p className="text-danger small" role="alert">
            Укажите категорию товара в карточке — без неё шаблон этикетки не подбирается.
          </p>
        ) : (
          <label className="form-label" htmlFor="product-label-print-copies">
            Количество этикеток
          </label>
        )}

        {canPrint ? (
          <input
            id="product-label-print-copies"
            type="number"
            className="form-control"
            min={1}
            max={MAX_COPIES}
            step={1}
            value={copies}
            disabled={printing}
            onChange={(e) => setCopies(e.target.value)}
            autoFocus
          />
        ) : null}

        {error ? (
          <p className="text-danger small mt-2 mb-0" role="alert">
            {error}
          </p>
        ) : null}

        <div className="d-flex flex-wrap gap-2 justify-content-end mt-3">
          <Button type="button" variant="secondary" onClick={onClose} disabled={printing}>
            Отмена
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!canPrint || printing}
          >
            {printing ? 'Печать…' : 'Печать'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
