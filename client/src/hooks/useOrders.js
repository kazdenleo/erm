/**
 * useOrders Hook
 * Custom hook для работы с заказами
 */

import { useState, useEffect, useCallback } from 'react';
import { ordersApi } from '../services/orders.api';

export function useOrders(options = {}) {
  const autoLoad = options.autoLoad !== false;
  const [orders, setOrders] = useState([]);
  const [meta, setMeta] = useState({ total: null, limit: null, offset: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  /**
   * @param {boolean | { silent?: boolean }} [options] — при silent=true не трогаем loading
   * (чтобы не скрывать всю страницу при обновлении списка после смены статуса и т.п.)
   */
  const loadOrders = useCallback(async (options) => {
    const silent = options === true || Boolean(options?.silent);
    try {
      if (!silent) {
        setLoading(true);
      }
      setError(null);
      const params = options && typeof options === 'object' ? (options.params || {}) : {};
      const response = await ordersApi.getAll(params);
      const loadedOrders = Array.isArray(response?.data) ? response.data : [];
      setOrders(loadedOrders);
      setMeta({
        total: response?.meta?.total ?? null,
        limit: response?.meta?.limit ?? params.limit ?? null,
        offset: response?.meta?.offset ?? params.offset ?? 0,
      });
    } catch (err) {
      console.error('Error loading orders:', err);
      setError(err.message || 'Ошибка загрузки заказов');
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
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
    loadOrders
  };
}


