/**
 * В приёмке: показать закреплённую ячейку или предложить закрепить (ввод / скан адреса).
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { addressStorageApi, addressStorageError } from '../../services/addressStorage.api';
import { AddressBadge } from './AddressBadge';
import './AddressStorage.shared.css';

export function ReceiptAssignCell({
  warehouseId,
  productId,
  address = null,
  large = false,
  onAssigned,
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [codes, setCodes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const listId = useId();
  const wid = Number(warehouseId);
  const pid = Number(productId);
  const hasWh = Number.isFinite(wid) && wid > 0;
  const hasPid = Number.isFinite(pid) && pid > 0;

  useEffect(() => {
    if (!editing) return undefined;
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [editing]);

  const startEdit = async () => {
    if (!hasWh || !hasPid) return;
    setEditing(true);
    setError(null);
    setValue('');
    if (!codes) {
      try {
        const list = await addressStorageApi.listLocations(wid);
        setCodes((list || []).filter((l) => l.isActive).map((l) => ({ id: l.id, code: l.code })));
      } catch (e) {
        setError(addressStorageError(e).message);
      }
    }
  };

  const save = async (raw) => {
    const code = String(raw ?? value).trim();
    if (!code) {
      setError('Укажите адрес ячейки');
      return;
    }
    if (!hasWh || !hasPid) {
      setError('Сначала выберите склад приёмки');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let locationId = null;
      try {
        const resolved = await addressStorageApi.resolveScan(wid, code);
        if (resolved?.type === 'location' && resolved.location?.id) {
          locationId = Number(resolved.location.id);
        }
      } catch {
        /* не штрихкод ячейки — ищем по адресу */
      }
      if (!locationId) {
        let list = codes;
        if (!list) {
          const locs = await addressStorageApi.listLocations(wid);
          list = (locs || []).filter((l) => l.isActive).map((l) => ({ id: l.id, code: l.code }));
          setCodes(list);
        }
        const loc = list.find((c) => c.code.toUpperCase() === code.toUpperCase());
        if (!loc) {
          setError(`Ячейки «${code}» нет на этом складе`);
          return;
        }
        locationId = loc.id;
      }
      await addressStorageApi.assignProduct(wid, pid, locationId);
      setEditing(false);
      setValue('');
      await onAssigned?.();
    } catch (e) {
      setError(addressStorageError(e).message);
    } finally {
      setBusy(false);
    }
  };

  if (address) {
    return (
      <AddressBadge
        address={address}
        large={large}
        title="Закреплённая ячейка — сюда класть при приёмке"
      />
    );
  }

  if (!hasWh) {
    return (
      <span className="receipt-assign-cell receipt-assign-cell--hint">
        Выберите склад, чтобы закрепить ячейку
      </span>
    );
  }

  if (editing) {
    return (
      <div className="receipt-assign-cell receipt-assign-cell--edit">
        <input
          ref={inputRef}
          className="form-control form-control-sm receipt-assign-cell__input"
          list={listId}
          value={value}
          disabled={busy}
          placeholder="Скан или адрес ячейки"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              void save(e.currentTarget.value);
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
              setError(null);
            }
          }}
        />
        <datalist id={listId}>
          {(codes || []).map((c) => (
            <option key={c.id} value={c.code} />
          ))}
        </datalist>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void save()}>
          OK
        </button>
        <button
          type="button"
          className="btn btn-sm btn-link"
          disabled={busy}
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
        >
          Отмена
        </button>
        {error ? <span className="receipt-assign-cell__error">{error}</span> : null}
      </div>
    );
  }

  return (
    <div className="receipt-assign-cell">
      <span className="receipt-assign-cell--hint">Ячейка не закреплена</span>
      <button type="button" className="btn btn-sm btn-link receipt-assign-cell__cta" onClick={() => void startEdit()}>
        Закрепить за ячейкой
      </button>
      {error ? <span className="receipt-assign-cell__error">{error}</span> : null}
    </div>
  );
}
