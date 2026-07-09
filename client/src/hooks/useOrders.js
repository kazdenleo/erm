/**
 * useOrders Hook
 * Custom hook для работы с заказами
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { ordersApi } from '../services/orders.api';

export function useOrders(options = {}) {
  const autoLoad = options.autoLoad !== false;
  const [orders, setOrders] = useState([]);
  const [meta, setMeta] = useState({ total: null, limit: null, offset: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  /** Счётчик запросов: в state попадает только ответ последнего (устаревшие ответы отбрасываются). */
  const loadSeqRef = useRef(0);
  /** Сколько не-silent запросов в полёте — чтобы не залипать в loading при отменённых ответах. */
  const visibleLoadCountRef = useRef(0);

  /**
   * @param {boolean | { silent?: boolean, params?: object }} [options] — при silent=true не трогаем loading
   * (чтобы не скрывать всю страницу при обновлении списка после смены статуса и т.п.)
   */
  const loadOrders = useCallback(async (options) => {
    const silent = options === true || Boolean(options?.silent);
    const seq = ++loadSeqRef.current;
    if (!silent) {
      visibleLoadCountRef.current += 1;
      setLoading(true);
    }
    try {
      setError(null);
      const params =
        options && typeof options === 'object' ? { ...(options.params || {}) } : {};
      if (silent) {
        params.skipAutoReserve = '1';
      }
      const response = await ordersApi.getAll(params);
      if (seq !== loadSeqRef.current) {
        return { data: null, meta: null, stale: true };
      }
      const loadedOrders = Array.isArray(response?.data) ? response.data : [];
      setOrders(loadedOrders);
      const nextMeta = {
        total: response?.meta?.total ?? null,
        limit: response?.meta?.limit ?? params.limit ?? null,
        offset: response?.meta?.offset ?? params.offset ?? 0,
      };
      setMeta(nextMeta);
      return { data: loadedOrders, meta: nextMeta };
    } catch (err) {
      if (seq !== loadSeqRef.current) {
        return { data: null, meta: null, stale: true };
      }
      console.error('Error loading orders:', err);
      setError(err.message || 'Ошибка загрузки заказов');
      return { data: [], meta: { total: null, limit: null, offset: 0 } };
    } finally {
      if (!silent) {
        visibleLoadCountRef.current = Math.max(0, visibleLoadCountRef.current - 1);
        if (visibleLoadCountRef.current === 0) {
          setLoading(false);
        }
      }
    }
  }, []);

  const patchOrders = useCallback((updater) => {
    setOrders((prev) => (typeof updater === 'function' ? updater(prev) : updater));
  }, []);

  useEffect(() => {
    if (autoLoad) {
      loadOrders();
    } else {
      setLoading(false);
    }
  }, [autoLoad, loadOrders]);

  return {
    orders,
    meta,
    loading,
    error,
    loadOrders,
    patchOrders,
  };
}
