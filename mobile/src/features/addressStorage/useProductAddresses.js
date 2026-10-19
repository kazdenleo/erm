import { useCallback, useEffect, useMemo, useState } from 'react';
import { addressStorageApi } from '../../api/erp';

/**
 * Ячейки для набора товаров (как на веб-сборке).
 * Запрос только если адресное хранение включено хотя бы на одном складе.
 */
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

  const primaryFor = useCallback(
    (productId, warehouseId = null) => {
      const list = map[Number(productId)];
      if (!list?.length) return null;
      if (warehouseId != null) {
        const own = list.find((x) => Number(x.warehouseId) === Number(warehouseId));
        if (own) return own;
      }
      return list.find((x) => x.assigned) || list[0];
    },
    [map]
  );

  const codeFor = useCallback(
    (productId, warehouseId = null) => primaryFor(productId, warehouseId)?.code || null,
    [primaryFor]
  );

  return { enabled, codeFor, primaryFor };
}
