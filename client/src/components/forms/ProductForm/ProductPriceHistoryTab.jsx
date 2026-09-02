/**
 * Вкладка «Цены»: история изменения минимума и фактической цены.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../common/Button/Button';
import { pricingStrategiesApi } from '../../../services/pricingStrategies.api.js';
import { PriceChangeHistoryTable } from '../../../pages/Prices/PriceChangeHistoryTable.jsx';
import '../../../pages/Prices/PriceHistory.css';

export function ProductPriceHistoryTab({ productId }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [marketplace, setMarketplace] = useState('');

  const load = useCallback(async () => {
    if (!productId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await pricingStrategiesApi.priceChanges({
        days: 30,
        limit: 200,
        productId,
        marketplace: marketplace || undefined,
      });
      const data = res?.data || {};
      setItems(data.items || []);
      setTotal(data.total ?? 0);
    } catch (e) {
      setError(e.response?.data?.message || e.message);
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [productId, marketplace]);

  useEffect(() => {
    load();
  }, [load]);

  if (!productId) {
    return (
      <p className="text-muted">
        Сохраните товар — после этого здесь появится история изменения цен.
      </p>
    );
  }

  return (
    <div className="product-price-history-tab">
      <p className="price-history-tab-hint">
        Как менялись минимум и фактическая цена на маркетплейсах и на каком основании.
        Журнал хранится 30 дней.{' '}
        <Link to={`/prices/history?productId=${productId}`} style={{ color: 'var(--primary)' }}>
          Открыть на странице истории
        </Link>
      </p>
      <div className="price-history-toolbar" style={{ marginTop: 0 }}>
        <label className="price-history-field">
          Маркетплейс
          <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)}>
            <option value="">Все</option>
            <option value="ozon">Ozon</option>
            <option value="wb">Wildberries</option>
            <option value="ym">Яндекс.Маркет</option>
          </select>
        </label>
        <Button type="button" variant="secondary" onClick={load} disabled={loading}>
          {loading ? 'Загрузка…' : 'Обновить'}
        </Button>
        <span className="price-history-meta" style={{ margin: 0, alignSelf: 'center' }}>
          Записей: {total}
        </span>
      </div>
      <PriceChangeHistoryTable
        items={items}
        loading={loading}
        error={error}
        hideProductColumn
        emptyText="Пока нет записей. Они появятся после пересчёта минимума, стратегии или ручного изменения фактической цены."
      />
    </div>
  );
}
