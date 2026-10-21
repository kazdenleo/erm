/**
 * Адреса ячеек для набора товаров (сборка, сбор FBO, приёмка).
 * Ничего не запрашивает, если ни на одном (или на указанном) складе не включено адресное хранение.
 *
 * @param {Array<number|string>} productIds
 * @param {{ warehouseId?: number|string|null }} [options]
 *   warehouseId — показывать/искать ячейки только на этом складе (приёмка на FBO не должна
 *   подтягивать закрепления со склада FBS).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { addressStorageApi } from '../services/addressStorage.api';

function toPositiveInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function useProductAddresses(productIds, options = {}) {
  const scopedWarehouseId = toPositiveInt(options?.warehouseId);

  const key = useMemo(() => {
    const ids = [...new Set((productIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    ids.sort((a, b) => a - b);
    return ids.join(',');
  }, [productIds]);

  const [enabled, setEnabled] = useState(false);
  const [map, setMap] = useState({});
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    addressStorageApi
      .listWarehouses({ force: reloadToken > 0 })
      .then((list) => {
        if (cancelled) return;
        const warehouses = list || [];
        if (scopedWarehouseId != null) {
          const w = warehouses.find((x) => Number(x.id) === scopedWarehouseId);
          setEnabled(Boolean(w?.settings?.enabled));
        } else {
          setEnabled(warehouses.some((w) => w.settings?.enabled));
        }
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken, scopedWarehouseId]);

  useEffect(() => {
    if (!enabled || !key) {
      setMap({});
      return undefined;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      addressStorageApi
        .lookup(key.split(',').map(Number))
        .then((data) => {
          if (cancelled) return;
          const raw = data || {};
          if (scopedWarehouseId == null) {
            setMap(raw);
            return;
          }
          const filtered = {};
          for (const [pid, list] of Object.entries(raw)) {
            const scoped = (list || []).filter((x) => Number(x.warehouseId) === scopedWarehouseId);
            if (scoped.length) filtered[pid] = scoped;
          }
          setMap(filtered);
        })
        .catch(() => {
          if (!cancelled) setMap({});
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [enabled, key, reloadToken, scopedWarehouseId]);

  /** Основной адрес товара: на указанном складе (без подмены складом FBS/другим). */
  const primaryFor = useCallback(
    (productId, warehouseId = null) => {
      const list = map[Number(productId)];
      if (!list?.length) return null;
      const wid = toPositiveInt(warehouseId) ?? scopedWarehouseId;
      if (wid != null) {
        return list.find((x) => Number(x.warehouseId) === wid) || null;
      }
      return list[0];
    },
    [map, scopedWarehouseId]
  );

  const addressFor = useCallback(
    (productId, warehouseId = null) => {
      const list = map[Number(productId)];
      if (!list?.length) return null;
      const wid = toPositiveInt(warehouseId) ?? scopedWarehouseId;
      const scoped =
        wid != null ? list.filter((x) => Number(x.warehouseId) === wid) : list.filter((x) => x.warehouseId === list[0].warehouseId);
      if (!scoped.length) return null;
      return scoped.map((x) => x.code).slice(0, 3).join(', ');
    },
    [map, scopedWarehouseId]
  );

  const routeFor = useCallback(
    (productId, warehouseId = null) => {
      const p = primaryFor(productId, warehouseId);
      return p ? p.routeOrder : Number.POSITIVE_INFINITY;
    },
    [primaryFor]
  );

  return { enabled, map, addressFor, routeFor, primaryFor, reload };
}
