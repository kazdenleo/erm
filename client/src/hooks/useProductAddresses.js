/**
 * Адреса ячеек для набора товаров (сборка, сбор FBO).
 * Ничего не запрашивает, если ни на одном складе не включено адресное хранение.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { addressStorageApi } from '../services/addressStorage.api';

export function useProductAddresses(productIds) {
  const key = useMemo(() => {
    const ids = [...new Set((productIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    ids.sort((a, b) => a - b);
    return ids.join(',');
  }, [productIds]);

  const [enabled, setEnabled] = useState(false);
  const [map, setMap] = useState({});

  useEffect(() => {
    let cancelled = false;
    addressStorageApi
      .listWarehouses()
      .then((list) => {
        if (!cancelled) setEnabled((list || []).some((w) => w.settings?.enabled));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !key) return undefined;
    let cancelled = false;
    const t = setTimeout(() => {
      addressStorageApi
        .lookup(key.split(',').map(Number))
        .then((data) => {
          if (!cancelled) setMap(data || {});
        })
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [enabled, key]);

  /** Основной адрес товара: на складе заказа, иначе на любом складе с адресным хранением. */
  const primaryFor = useCallback(
    (productId, warehouseId = null) => {
      const list = map[Number(productId)];
      if (!list?.length) return null;
      if (warehouseId != null) {
        const own = list.find((x) => Number(x.warehouseId) === Number(warehouseId));
        if (own) return own;
      }
      return list[0];
    },
    [map]
  );

  const addressFor = useCallback(
    (productId, warehouseId = null) => {
      const list = map[Number(productId)];
      if (!list?.length) return null;
      const scoped =
        warehouseId != null && list.some((x) => Number(x.warehouseId) === Number(warehouseId))
          ? list.filter((x) => Number(x.warehouseId) === Number(warehouseId))
          : list.filter((x) => x.warehouseId === list[0].warehouseId);
      return scoped.map((x) => x.code).slice(0, 3).join(', ');
    },
    [map]
  );

  const routeFor = useCallback(
    (productId, warehouseId = null) => {
      const p = primaryFor(productId, warehouseId);
      return p ? p.routeOrder : Number.POSITIVE_INFINITY;
    },
    [primaryFor]
  );

  return { enabled, map, addressFor, routeFor, primaryFor };
}
