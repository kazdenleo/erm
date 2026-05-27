/**
 * Модалка: неизвестный штрихкод → привязать к существующему товару (с показом уже привязанных кодов).
 */

import React, { useEffect, useState } from 'react';
import { Modal } from '../Modal/Modal';
import { Button } from '../Button/Button';
import { ProductSearchInput } from '../ProductSearchInput/ProductSearchInput';
import { productsApi } from '../../../services/products.api';
import { barcodeStringsFromProduct } from '../../../utils/productBarcodes.js';
import { playEventSound, SOUND_EVENTS } from '../../../utils/soundSettings';
import './LinkBarcodeToProductModal.css';

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

  const handleLink = async () => {
    if (!trimmedBarcode || !productId) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await productsApi.appendBarcode(productId, trimmedBarcode);
      playEventSound(SOUND_EVENTS.scan_ok);
      onLinked?.(updated);
    } catch (e) {
      setError(
        e.response?.data?.message ||
          e.message ||
          'Не удалось сохранить (возможно, штрихкод уже у другого товара)'
      );
      playEventSound(SOUND_EVENTS.scan_error);
    } finally {
      setSaving(false);
    }
  };

  const existingBarcodes = barcodeStringsFromProduct(detail?.barcodes);

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
          Поиск товара (штрихкод, артикул, название)
          <ProductSearchInput
            value={search}
            onChange={setSearch}
            products={products}
            disabled={saving}
            placeholder="Введите для поиска…"
            className="warehouse-ops-scan-input link-barcode-modal__search"
            onSelect={(p) => {
              if (p?.id) setProductId(String(p.id));
              setSearch('');
            }}
          />
        </label>

        {productId ? (
          <p className="warehouse-ops-hint link-barcode-modal__cap-hint">
            Выбран: {detail?.sku || productId}
            {detail?.name ? ` — ${detail.name}` : ''}
          </p>
        ) : (
          <p className="warehouse-ops-hint link-barcode-modal__cap-hint">
            Выберите товар из подсказок поиска.
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
