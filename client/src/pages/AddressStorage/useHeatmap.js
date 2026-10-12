import { useEffect, useMemo, useState } from 'react';
import { addressStorageApi } from '../../services/addressStorage.api';
import { heatMaxima } from './addressStorageUtils';

/** Статистика ячеек для тепловой карты; reloadKey — перезапрос после изменений. */
export function useHeatmap(warehouseId, days, reloadKey) {
  const [cells, setCells] = useState([]);

  useEffect(() => {
    if (!warehouseId) return undefined;
    let cancelled = false;
    addressStorageApi
      .getHeatmap(warehouseId, days)
      .then((r) => {
        if (!cancelled) setCells(r?.cells || []);
      })
      .catch(() => {
        if (!cancelled) setCells([]);
      });
    return () => {
      cancelled = true;
    };
  }, [warehouseId, days, reloadKey]);

  const statsById = useMemo(() => new Map(cells.map((c) => [c.locationId, c])), [cells]);
  const maxima = useMemo(() => heatMaxima(cells), [cells]);
  return { statsById, maxima };
}
