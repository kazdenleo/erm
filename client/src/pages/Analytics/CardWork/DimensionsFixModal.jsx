/**
 * Модалка правки габаритов упаковки ERP (мм / г) из «Работы с карточками».
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

function numStr(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '';
}

function parsePositive(raw) {
  const s = String(raw ?? '').trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return n;
}

const FIELDS = [
  { key: 'length', label: 'Длина, мм' },
  { key: 'width', label: 'Ширина, мм' },
  { key: 'height', label: 'Высота, мм' },
  { key: 'weight', label: 'Вес, г' },
];

export function DimensionsFixModal({ isOpen, onClose, productId, marketplaceHint, onSaved }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [product, setProduct] = useState(null);
  const [form, setForm] = useState({ length: '', width: '', height: '', weight: '' });

  const load = useCallback(async () => {
    if (!productId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await productsApi.getById(productId);
      const p = unwrapProduct(res);
      if (!p?.id) throw new Error('Карточка не найдена');
      setProduct(p);
      setForm({
        length: numStr(p.length),
        width: numStr(p.width),
        height: numStr(p.height),
        weight: numStr(p.weight),
      });
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить карточку');
      setProduct(null);
      setForm({ length: '', width: '', height: '', weight: '' });
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
    return sku ? `Размеры: ${sku}` : 'Размеры упаковки';
  }, [product]);

  const setField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    if (!product?.id) return;
    const updates = {};
    for (const f of FIELDS) {
      const n = parsePositive(form[f.key]);
      if (Number.isNaN(n)) {
        setError(`${f.label}: укажите число ≥ 0`);
        return;
      }
      if (n != null) updates[f.key] = n;
      else updates[f.key] = null;
    }
    setSaving(true);
    setError(null);
    try {
      await productsApi.update(product.id, updates);
      if (typeof onSaved === 'function') await onSaved();
      onClose();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="medium" scrollable>
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

        {marketplaceHint ? (
          <p className="card-work-fix-modal__hint-block">{marketplaceHint}</p>
        ) : (
          <p className="card-work-fix-modal__lead">
            Габариты упаковки на вкладке «Основное» (мм / г). После сохранения сверьте с карточкой МП.
          </p>
        )}

        {error ? <div className="sales-analytics__error">{error}</div> : null}
        {loading ? <p className="sales-analytics__empty">Загрузка…</p> : null}

        {!loading && product ? (
          <div className="card-work-fix-modal__fields card-work-fix-modal__fields--grid">
            {FIELDS.map((f) => (
              <label key={f.key} className="card-work-fix-modal__field">
                <span>{f.label}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={form[f.key]}
                  onChange={(e) => setField(f.key, e.target.value)}
                  disabled={saving}
                  placeholder="0"
                />
              </label>
            ))}
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
