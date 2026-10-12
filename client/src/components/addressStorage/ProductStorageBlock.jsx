/**
 * Блок «Где лежит» в карточке товара: закреплённая ячейка и остатки по ячейкам на складах
 * с включённым адресным хранением. Без таких складов ничего не рисует.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { addressStorageApi, addressStorageError } from '../../services/addressStorage.api';
import './AddressStorage.shared.css';

function WarehouseRow({ productId, wh, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [codes, setCodes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const startEdit = async () => {
    setEditing(true);
    setError(null);
    setValue(wh.assigned?.code || '');
    if (!codes) {
      try {
        const list = await addressStorageApi.listLocations(wh.warehouseId);
        setCodes((list || []).filter((l) => l.isActive).map((l) => ({ id: l.id, code: l.code })));
      } catch (e) {
        setError(addressStorageError(e).message);
      }
    }
  };

  const save = async () => {
    const code = value.trim();
    const loc = code ? (codes || []).find((c) => c.code.toUpperCase() === code.toUpperCase()) : null;
    if (code && !loc) {
      setError(`Ячейки «${code}» нет на этом складе`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addressStorageApi.assignProduct(wh.warehouseId, productId, loc ? loc.id : null);
      setEditing(false);
      await onChanged();
    } catch (e) {
      setError(addressStorageError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const listId = `product-storage-codes-${wh.warehouseId}`;
  return (
    <div className="product-storage-block__wh">
      <strong>{wh.warehouseName}:</strong>
      {editing ? (
        <>
          <input
            className="form-control form-control-sm"
            list={listId}
            value={value}
            placeholder="адрес ячейки"
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void save();
              }
              if (e.key === 'Escape') setEditing(false);
            }}
          />
          <datalist id={listId}>
            {(codes || []).map((c) => (
              <option key={c.id} value={c.code} />
            ))}
          </datalist>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>
            Сохранить
          </button>
          <button type="button" className="btn btn-sm btn-link" onClick={() => setEditing(false)}>
            Отмена
          </button>
        </>
      ) : (
        <>
          {wh.assigned ? (
            <span className="address-badge address-badge--lg" title="Закреплённая ячейка">
              📌 {wh.assigned.code}
            </span>
          ) : (
            <span className="muted-hint">ячейка не закреплена</span>
          )}
          <button type="button" className="btn btn-sm btn-link p-0" onClick={startEdit}>
            {wh.assigned ? 'изменить' : 'закрепить'}
          </button>
        </>
      )}
      {wh.settings?.trackQuantities ? (
        <>
          {wh.stocks.map((s) => (
            <span key={s.location.id} className="product-storage-block__stock">
              {s.location.code}: {s.quantity} шт
            </span>
          ))}
          {wh.unplaced ? <span className="product-storage-block__stock">без адреса: {wh.unplaced} шт</span> : null}
        </>
      ) : null}
      <Link
        className="btn btn-sm btn-link p-0"
        to={`/stock-levels/address-storage?wh=${wh.warehouseId}&tab=racks&product=${productId}`}
      >
        показать на стеллаже
      </Link>
      {error ? <span className="text-danger">{error}</span> : null}
    </div>
  );
}

export function ProductStorageBlock({ productId }) {
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    if (!productId) return;
    try {
      setData(await addressStorageApi.productLocations(productId));
    } catch {
      setData(null);
    }
  }, [productId]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const list = data?.warehouses || [];
  if (!productId || !list.length) return null;

  return (
    <div className="product-form-block product-storage-block">
      <h4 className="product-form-block__title">📍 Где лежит</h4>
      {list.map((wh) => (
        <WarehouseRow key={wh.warehouseId} productId={productId} wh={wh} onChanged={load} />
      ))}
    </div>
  );
}
