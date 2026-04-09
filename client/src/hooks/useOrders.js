/**
 * useOrders Hook
 * Custom hook для работы с заказами
 */

import { useState, useEffect, useCallback } from 'react';
import { ordersApi } from '../services/orders.api';

export function useOrders() {
  const [orders, setOrders] = useState([]);
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
      const loadedOrders = await ordersApi.getAll(params);
      setOrders(Array.isArray(loadedOrders) ? loadedOrders : []);
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
    loadOrders();
  }, [loadOrders]);

  return {
    orders,
    loading,
    error,
    loadOrders
  };
}


