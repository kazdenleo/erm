/**
 * История изменения цен: боковая колонка или блок внутри модалки расчёта мин. цены.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { pricingStrategiesApi } from '../../services/pricingStrategies.api.js';
import { PriceChangeHistoryTable } from './PriceChangeHistoryTable.jsx';
import './PriceHistory.css';

const MP_FILTER = new Set(['ozon', 'wb', 'ym']);

export function PriceHistorySidePanel({
  productId = null,
  productLabel = '',
  onClearProduct,
  compact = false,
  /** Внутри PriceDetailsModal — без кабинетной сводки */
  embedded = false,
  /** Предвыбор МП (ozon|wb|ym) */
  defaultMarketplace = '',
}) {
  const initialMp = MP_FILTER.has(String(defaultMarketplace || '').toLowerCase())
    ? String(defaultMarketplace).toLowerCase()
    : '';
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [marketplace, setMarketplace] = useState(initialMp);

  const hasProduct = productId != null && Number(productId) > 0;

  useEffect(() => {
    setMarketplace(initialMp);
  }, [initialMp, productId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await pricingStrategiesApi.priceChanges({
        days: 30,
        limit: compact || embedded ? 60 : 150,
        productId: hasProduct ? productId : undefined,
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
  }, [productId, marketplace, hasProduct, compact, embedded]);

  useEffect(() => {
    load();
  }, [load]);

  const historyHref = hasProduct
    ? `/prices/history?productId=${productId}`
    : '/prices/history';

  const Tag = embedded ? 'div' : 'aside';
  const rootClass = embedded
    ? 'price-history-embedded'
    : `price-history-side${compact ? ' is-compact' : ''}`;

  return (
    <Tag className={rootClass}>
      <div className={embedded ? 'price-history-embedded__head' : 'price-history-side__head'}>
        <h3 className={embedded ? 'price-details-subtitle' : 'h6 mb-0'}>
          История изменения цен
        </h3>
        <Link to={historyHref} className="price-history-side__all">
          Открыть полностью
        </Link>
      </div>
      {hasProduct && !embedded ? (
        <div className="price-history-side__selected">
          <span>
            {productLabel || `Товар #${productId}`}
          </span>
          {onClearProduct ? (
            <button type="button" onClick={onClearProduct} title="Показать все товары">
              ×
            </button>
          ) : null}
        </div>
      ) : null}
      {!hasProduct && !embedded ? (
        <p className="price-history-tab-hint" style={{ marginBottom: 8 }}>
          Сводка по кабинету. Кликните товар слева — справа останется его история и причина.
        </p>
      ) : null}
      <div className="price-history-toolbar" style={{ marginTop: 0, marginBottom: 8 }}>
        <label className="price-history-field">
          Маркетплейс
          <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)}>
            <option value="">Все</option>
            <option value="ozon">Ozon</option>
            <option value="wb">Wildberries</option>
            <option value="ym">Яндекс.Маркет</option>
          </select>
        </label>
        <Button type="button" variant="secondary" size="small" onClick={load} disabled={loading}>
          {loading ? '…' : 'Обновить'}
        </Button>
      </div>
      <div className="price-history-meta" style={{ marginBottom: 6 }}>
        Записей: {total}
      </div>
      <PriceChangeHistoryTable
        items={items}
        loading={loading}
        error={error}
        hideProductColumn={hasProduct}
        emptyText={
          hasProduct
            ? 'По этому товару пока нет записей за 30 дней.'
            : 'Пока нет изменений. Они появятся после пересчёта минимума или стратегии.'
        }
      />
    </Tag>
  );
}
