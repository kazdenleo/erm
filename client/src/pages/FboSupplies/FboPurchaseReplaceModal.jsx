/**
 * Замена / добавление товара в строке поставки (расчёт закупки FBO)
 */

import React, { useCallback, useEffect, useState } from 'react';
import { productsApi } from '../../services/products.api';
import { useProducts } from '../../hooks/useProducts';
import { Modal } from '../../components/common/Modal/Modal';
import { Button } from '../../components/common/Button/Button';
import { barcodeStringsFromProduct } from '../../utils/productBarcodes.js';

function normalizeProductSearchQuery(value) {
  return String(value || '').trim();
}

function matchProductsLocal(products, query) {
  const q = normalizeProductSearchQuery(query).toLowerCase();
  if (!q) return [];
  const list = products || [];
  const exactSku = list.filter((p) => String(p?.sku || '').trim().toLowerCase() === q);
  if (exactSku.length) return exactSku.slice(0, 30);
  const exactBarcode = list.filter((p) =>
    barcodeStringsFromProduct(p.barcodes).some(
      (b) => String(b || '').trim().toLowerCase() === q
    )
  );
  if (exactBarcode.length) return exactBarcode.slice(0, 30);
  const scored = list
    .map((p) => {
      const sku = String(p?.sku || '').toLowerCase();
      const name = String(p?.name || '').toLowerCase();
      const barcodes = barcodeStringsFromProduct(p.barcodes)
        .map((b) => String(b || '').toLowerCase())
        .join(' ');
      const hitSku = sku.includes(q);
      const hitName = name.includes(q);
      const hitBarcode = barcodes.includes(q);
      if (!hitSku && !hitName && !hitBarcode) return null;
      const score =
        (hitSku ? 2 : 0) + (hitName ? 1 : 0) + (hitBarcode ? 2 : 0) + (sku.startsWith(q) ? 1 : 0);
      return { p, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return scored.map((x) => x.p).slice(0, 30);
}

function mergeProductLists(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const p of list || []) {
      if (p?.id == null) continue;
      map.set(String(p.id), p);
    }
  }
  return [...map.values()];
}

export function FboPurchaseReplaceModal({ context, saving, onClose, onConfirm }) {
  const { products } = useProducts();
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [quantity, setQuantity] = useState('1');
  const [localErr, setLocalErr] = useState(null);

  useEffect(() => {
    if (!context) return;
    setSearch('');
    setSearchResults([]);
    setSelectedProduct(null);
    setQuantity(String(context.defaultQty > 0 ? context.defaultQty : 1));
    setLocalErr(null);
  }, [context]);

  useEffect(() => {
    if (!context) return undefined;
    const q = normalizeProductSearchQuery(search);
    if (!q) {
      setSearchResults([]);
      setSearchLoading(false);
      return undefined;
    }
    const local = matchProductsLocal(products, q);
    if (local.length) setSearchResults(local);
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await productsApi.getAll({ search: q, limit: 40 });
        const remote = Array.isArray(res?.data) ? res.data : [];
        if (!cancelled) setSearchResults(mergeProductLists(local, remote));
      } catch {
        if (!cancelled) setSearchResults(local);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 320);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [context, search, products]);

  const pickProduct = useCallback((p) => {
    setSelectedProduct(p);
    setSearch('');
    setSearchResults([]);
    setLocalErr(null);
  }, []);

  const handleSubmit = () => {
    if (!selectedProduct?.id) {
      setLocalErr('Выберите товар из списка');
      return;
    }
    const qty = parseInt(quantity, 10);
    if (!Number.isFinite(qty) || qty <= 0) {
      setLocalErr('Укажите количество больше 0');
      return;
    }
    onConfirm({
      productId: Number(selectedProduct.id),
      quantity: qty,
      product: selectedProduct,
    });
  };

  if (!context) return null;

  const isAdd = context.mode === 'add';
  const title = isAdd ? 'Добавить аналог в поставку' : 'Заменить товар в поставке';

  return (
    <Modal isOpen onClose={() => !saving && onClose()} title={title} size="medium">
      <p className="text-muted small mb-2">
        Поставка: <strong>{context.supplyLabel}</strong>
        {context.currentProductName ? (
          <>
            <br />
            Сейчас: <strong>{context.currentProductName}</strong>
            {context.currentSku ? ` (${context.currentSku})` : ''}
          </>
        ) : null}
      </p>
      {isAdd ? (
        <p className="text-muted small">
          Исходная позиция комплекта в поставке сохранится. В таблице появится строка с выбранным
          товаром, если его ещё не было.
        </p>
      ) : (
        <p className="text-muted small">
          Товар в строке поставки будет заменён. Если выбранный товар уже есть в таблице, количества
          объединятся.
        </p>
      )}

      {localErr && <div className="alert alert-danger py-2">{localErr}</div>}

      {selectedProduct ? (
        <div className="mb-3 p-2 border rounded bg-light">
          <div className="small text-muted">Выбран</div>
          <strong>{selectedProduct.name || selectedProduct.sku}</strong>
          {selectedProduct.sku ? (
            <span className="text-muted small ms-1">({selectedProduct.sku})</span>
          ) : null}
          <button
            type="button"
            className="btn btn-link btn-sm p-0 ms-2"
            onClick={() => setSelectedProduct(null)}
          >
            Сменить
          </button>
        </div>
      ) : (
        <div className="mb-3">
          <label className="form-label">Поиск товара</label>
          <input
            type="search"
            className="form-control form-control-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Артикул, название или штрихкод"
            autoFocus
          />
          {searchLoading ? <div className="small text-muted mt-1">Поиск…</div> : null}
          {searchResults.length > 0 ? (
            <ul className="list-group list-group-flush mt-2 fbo-pc-replace-search-list">
              {searchResults.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="list-group-item list-group-item-action py-2"
                    onClick={() => pickProduct(p)}
                  >
                    <div>{p.name || '—'}</div>
                    <div className="small text-muted">{p.sku || `#${p.id}`}</div>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {normalizeProductSearchQuery(search) && !searchLoading && searchResults.length === 0 ? (
            <div className="small text-muted mt-1">Ничего не найдено</div>
          ) : null}
        </div>
      )}

      <div className="mb-3">
        <label className="form-label">Количество в поставке</label>
        <input
          type="number"
          min={1}
          max={99999}
          className="form-control form-control-sm"
          style={{ maxWidth: 120 }}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
      </div>

      <div className="d-flex justify-content-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          Отмена
        </Button>
        <Button variant="primary" onClick={handleSubmit} disabled={saving}>
          {saving ? 'Сохранение…' : isAdd ? 'Добавить' : 'Заменить'}
        </Button>
      </div>
    </Modal>
  );
}
