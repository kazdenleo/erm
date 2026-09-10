/**
 * Модалка установки / изменения себестоимости карточки.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from '../../../components/common/Modal/Modal';
import { Button } from '../../../components/common/Button/Button';
import { productsApi } from '../../../services/products.api';
import { productCardPath } from '../../../utils/productCardPath.js';

function unwrapProduct(res) {
  const body = res?.data ?? res;
  return body?.data ?? body?.product ?? body;
}

function formatCost(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return String(n);
}

export function CostFixModal({ isOpen, onClose, productId, onSaved }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [product, setProduct] = useState(null);
  const [cost, setCost] = useState('');

  const load = useCallback(async () => {
    if (!productId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await productsApi.getById(productId);
      const p = unwrapProduct(res);
      if (!p?.id) throw new Error('Карточка не найдена');
      setProduct(p);
      setCost(formatCost(p.cost));
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить карточку');
      setProduct(null);
      setCost('');
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    if (!isOpen) return undefined;
    load();
    return undefined;
  }, [isOpen, load]);

  const title = useMemo(() => {
    const sku = product?.sku || '';
    return sku ? `Себестоимость: ${sku}` : 'Себестоимость';
  }, [product]);

  const isKit = String(product?.product_type || '').toLowerCase() === 'kit';

  const handleSave = async () => {
    if (!product?.id) return;
    const raw = String(cost ?? '').trim().replace(',', '.');
    if (raw === '') {
      setError('Укажите себестоимость');
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      setError('Себестоимость должна быть числом ≥ 0');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await productsApi.update(product.id, { cost: n });
      if (typeof onSaved === 'function') await onSaved();
      onClose();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="medium">
      <div className="card-work-fix-modal">
        {product ? (
          <p className="card-work-fix-modal__lead">
            {product.name || 'Без названия'}{' '}
            <Link
              className="card-work__link"
              to={productCardPath(product.id)}
              target="_blank"
              rel="noreferrer"
            >
              открыть карточку
            </Link>
          </p>
        ) : null}

        {error ? <div className="sales-analytics__error">{error}</div> : null}
        {loading ? <p className="sales-analytics__empty">Загрузка…</p> : null}

        {!loading && product ? (
          <div className="card-work-fix-modal__fields">
            <label className="card-work-fix-modal__field">
              <span>Себестоимость, ₽</span>
              <input
                type="text"
                inputMode="decimal"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                disabled={saving}
                placeholder="0"
                autoFocus
              />
              {isKit ? (
                <span className="card-work-fix-modal__hint">
                  Для комплекта себестоимость обычно считается по комплектующим; ручное значение
                  может быть пересчитано.
                </span>
              ) : null}
            </label>
          </div>
        ) : null}

        <div className="card-work-fix-modal__actions">
          <Button variant="secondary" size="small" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button
            variant="primary"
            size="small"
            onClick={handleSave}
            disabled={saving || loading || !product}
          >
            {saving ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
