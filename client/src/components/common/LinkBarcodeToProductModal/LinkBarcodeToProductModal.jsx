/**
 * Модалка: неизвестный штрихкод → привязать к существующему товару (с показом уже привязанных кодов).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Modal } from '../Modal/Modal';
import { Button } from '../Button/Button';
import { productsApi } from '../../../services/products.api';
import './LinkBarcodeToProductModal.css';

const OPTION_CAP = 400;

export function LinkBarcodeToProductModal({
  isOpen,
  onClose,
  barcode,
  products = [],
  onLinked,
  title = 'Привязать штрихкод к товару',
}) {
  const trimmedBarcode = String(barcode || '').trim();
  const [search, setSearch] = useState('');
  const [productId, setProductId] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isOpen) {
      setSearch('');
      setProductId('');
      setDetail(null);
      setError(null);
      setSaving(false);
      setDetailLoading(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !productId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setError(null);
    productsApi
      .getById(productId)
      .then((wrap) => {
        const p = wrap?.data ?? wrap;
        if (!cancelled && p?.id) setDetail(p);
        else if (!cancelled) setDetail(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e.response?.data?.message || e.message || 'Не удалось загрузить товар');
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, productId]);

  const filteredProducts = useMemo(() => {
    const list = Array.isArray(products) ? products.filter(Boolean) : [];
    const q = search.trim().toLowerCase();
    if (!q) return list.slice(0, OPTION_CAP);
    const out = list.filter(
      (p) =>
        String(p.sku || '')
          .toLowerCase()
          .includes(q) || String(p.name || '').toLowerCase().includes(q)
    );
    return out.length > OPTION_CAP ? out.slice(0, OPTION_CAP) : out;
  }, [products, search]);

  const handleLink = async () => {
    if (!trimmedBarcode || !productId) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await productsApi.appendBarcode(productId, trimmedBarcode);
      onLinked?.(updated);
    } catch (e) {
      setError(
        e.response?.data?.message ||
          e.message ||
          'Не удалось сохранить (возможно, штрихкод уже у другого товара)'
      );
    } finally {
      setSaving(false);
    }
  };

  const existingBarcodes = Array.isArray(detail?.barcodes)
    ? detail.barcodes.map((b) => String(b).trim()).filter(Boolean)
    : [];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="large" closeOnBackdropClick={!saving}>
      <div className="link-barcode-modal">
        <p className="warehouse-ops-hint">
          Код не найден в базе (при приёмке). Укажите товар, к которому относится этикетка — штрихкод будет добавлен к карточке; дальше он будет находиться при сканировании везде.
        </p>
        <div className="link-barcode-modal__scanned">
          <span className="link-barcode-modal__label">Отсканировано:</span>
          <code className="link-barcode-modal__code">{trimmedBarcode || '—'}</code>
        </div>

        <label className="link-barcode-modal__label-block">
          Поиск по артикулу или названию
          <input
            type="text"
            className="warehouse-ops-scan-input link-barcode-modal__search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Начните вводить…"
            autoComplete="off"
            disabled={saving}
          />
        </label>

        <label className="link-barcode-modal__label-block">
          Товар
          <select
            className="warehouse-ops-select"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            disabled={saving}
          >
            <option value="">— Выберите товар —</option>
            {filteredProducts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku || p.id} — {p.name || 'Без названия'}
              </option>
            ))}
          </select>
        </label>

        {!search.trim() && (products?.length || 0) > OPTION_CAP && (
          <p className="warehouse-ops-hint link-barcode-modal__cap-hint">
            Показаны первые {OPTION_CAP} товаров. Используйте поиск, чтобы сузить список.
          </p>
        )}

        <div className="link-barcode-modal__existing">
          <span className="link-barcode-modal__label">Штрихкоды у выбранного товара:</span>
          {detailLoading ? (
            <p className="muted">Загрузка…</p>
          ) : productId && existingBarcodes.length === 0 ? (
            <p className="muted">Пока нет привязанных штрихкодов</p>
          ) : productId ? (
            <ul className="link-barcode-modal__barcode-list">
              {existingBarcodes.map((b) => (
                <li key={b}>
                  <code>{b}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Выберите товар — список появится здесь</p>
          )}
        </div>

        {error && <div className="warehouse-ops-error">{error}</div>}

        <div className="link-barcode-modal__actions">
          <Button type="button" onClick={handleLink} disabled={saving || !productId || !trimmedBarcode}>
            {saving ? 'Сохранение…' : 'Привязать штрихкод'}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
        </div>
      </div>
    </Modal>
  );
}
