/**
 * Замена / добавление товара в строке поставки (расчёт закупки FBO)
 */

import React, { useCallback, useEffect, useState } from 'react';
import { productsApi } from '../../services/products.api';
import { Modal } from '../../components/common/Modal/Modal';
import { Button } from '../../components/common/Button/Button';
function normalizeProductSearchQuery(value) {
  return String(value || '').trim();
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
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await productsApi.getAll({ search: q, limit: 40 });
        const remote = Array.isArray(res?.data) ? res.data : [];
        if (!cancelled) setSearchResults(mergeProductLists([], remote));
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 320);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [context, search]);

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

  const isAdd = context.mode === 'add' || context.mode === 'add_all';
  const isPurchaseReplace = context.mode === 'purchase_replace';
  const isBulkAll =
    context.mode === 'replace_all' || context.mode === 'add_all' || isPurchaseReplace;
  const title = isPurchaseReplace
    ? 'Заменить товар в закупке'
    : context.mode === 'replace_all'
      ? 'Заменить товар во всех поставках'
      : context.mode === 'add_all'
        ? 'Добавить аналог во все поставки'
        : isAdd
          ? 'Добавить аналог в поставку'
          : 'Заменить товар в поставке';

  const handleLockedQtySubmit = () => {
    if (!selectedProduct?.id) {
      setLocalErr('Выберите товар из списка');
      return;
    }
    const qty = Math.max(1, parseInt(String(context.defaultQty || quantity), 10) || 1);
    onConfirm({
      productId: Number(selectedProduct.id),
      quantity: qty,
      product: selectedProduct,
    });
  };

  return (
    <Modal isOpen onClose={() => !saving && onClose()} title={title} size="medium">
      <p className="text-muted small mb-2">
        {context.supplyLabel ? (
          <>
            Поставка: <strong>{context.supplyLabel}</strong>
            <br />
          </>
        ) : null}
        {context.currentProductName ? (
          <>
            Сейчас: <strong>{context.currentProductName}</strong>
            {context.currentSku ? ` (${context.currentSku})` : ''}
          </>
        ) : null}
      </p>
      {isPurchaseReplace ? (
        <p className="text-muted small">
          В закупку попадёт выбранный товар. Количество останется{' '}
          <strong>{context.defaultQty > 0 ? context.defaultQty : 1}</strong> шт. Поставка FBO не
          меняется.
        </p>
      ) : context.mode === 'replace_all' ? (
        <p className="text-muted small">
          Товар будет заменён сразу во всех поставках этой строки (
          <strong>{Array.isArray(context.targets) ? context.targets.length : 0}</strong>
          ). Количество в каждой поставке сохранится.
        </p>
      ) : context.mode === 'add_all' ? (
        <p className="text-muted small">
          Аналог будет добавлен во все поставки этой строки (
          <strong>{Array.isArray(context.targets) ? context.targets.length : 0}</strong>
          ). Количество по каждой поставке сохранится; исходные позиции комплекта не меняются.
        </p>
      ) : isAdd ? (
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

      {!isBulkAll ? (
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
      ) : null}

      <div className="d-flex justify-content-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          Отмена
        </Button>
        <Button
          variant="primary"
          onClick={isBulkAll ? handleLockedQtySubmit : handleSubmit}
          disabled={saving}
        >
          {saving
            ? 'Сохранение…'
            : context.mode === 'add_all'
              ? 'Добавить во все'
              : isAdd
                ? 'Добавить'
                : context.mode === 'replace_all'
                  ? 'Заменить во всех'
                  : 'Заменить'}
        </Button>
      </div>
    </Modal>
  );
}
