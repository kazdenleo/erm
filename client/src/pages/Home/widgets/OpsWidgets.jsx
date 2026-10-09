/**
 * Операционные плашки главной: заказы, вопросы, возвраты, товары, остатки.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../../components/common/Button/Button';
import { Modal } from '../../../components/common/Modal/Modal';
import { productsApi } from '../../../services/products.api.js';
import { ordersApi } from '../../../services/orders.api';
import { questionsApi } from '../../../services/questions.api';
import { marketplaceReturnsApi } from '../../../services/marketplaceReturns.api';
import { MARKETPLACE_TABLE_BADGES } from '../../../constants/marketplaceUi';
import { cachedLoad, errorMessage, formatQty, formatRub, formatRubAmountInt } from './widgetUtils';

/** Плашка «Нужно обработать»: новые + на сборке (ещё не «Собран») */
const ORDER_NEED_PROCESS_STATUSES = ['new', 'in_assembly', 'wb_assembly'];

const EMPTY_RETURNS = { waitingCount: 0, countsByMarketplace: { ozon: 0, wildberries: 0, yandex: 0 } };

function useStockSummary(profileId) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(
    (force = false) => {
      setLoading(true);
      setError(null);
      return cachedLoad(`stock-summary:${profileId}`, () => productsApi.getHomeStockSummary(), { force })
        .then((d) => setData(d || null))
        .catch((e) => {
          setError(errorMessage(e, 'Не удалось загрузить сводку остатков'));
          setData(null);
        })
        .finally(() => setLoading(false));
    },
    [profileId]
  );

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, error, reload: () => load(true) };
}

function PlateLink({ to, title, linkClass, blockClass, children }) {
  return (
    <Link to={to} className={`text-decoration-none d-block h-100 ${linkClass}`} title={title}>
      <div className={`card mb-0 h-100 widget-content ${blockClass}`}>{children}</div>
    </Link>
  );
}

export function OrdersWidget({ profileId }) {
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    ordersApi
      .getStatusCounts()
      .then((counts) => {
        if (!alive) return;
        setCount(ORDER_NEED_PROCESS_STATUSES.reduce((acc, st) => acc + (Number(counts?.[st]) || 0), 0));
      })
      .catch((e) => {
        if (!alive) return;
        setError(e?.message || 'Не удалось загрузить счётчик заказов');
        setCount(0);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [profileId]);

  return (
    <PlateLink
      to="/orders"
      title="Открыть заказы"
      linkClass="home-orders-plate-link"
      blockClass="bg-arielle-smile home-orders-plate-block"
    >
      <div className="widget-content-wrapper text-white">
        <div className="widget-content-left">
          <div className="widget-heading">Заказы</div>
          <div className="widget-subheading">Новые и на сборке</div>
        </div>
        <div className="widget-content-right">
          <div className="widget-numbers text-white">
            <span>{loading ? '…' : error ? '—' : formatQty(count)}</span>
          </div>
        </div>
      </div>
    </PlateLink>
  );
}

export function QuestionsWidget({ user }) {
  const [count, setCount] = useState(0);

  const load = useCallback(async () => {
    if (user?.profileId == null || user?.profileId === '') {
      setCount(0);
      return;
    }
    try {
      const { newCount } = await questionsApi.getStats();
      setCount(typeof newCount === 'number' && Number.isFinite(newCount) ? newCount : 0);
    } catch {
      setCount(0);
    }
  }, [user?.profileId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    window.addEventListener('questions-stats-refresh', load);
    return () => {
      clearInterval(t);
      window.removeEventListener('questions-stats-refresh', load);
    };
  }, [load]);

  return (
    <PlateLink
      to="/questions"
      title="Открыть вопросы покупателей"
      linkClass="home-questions-plate-link"
      blockClass="bg-malibu-beach home-questions-plate-block"
    >
      <div className="widget-content-wrapper text-white">
        <div className="widget-content-left">
          <div className="widget-heading">Обработать вопросов</div>
          <div className="widget-subheading">Без ответа продавца</div>
        </div>
        <div className="widget-content-right">
          <div className="widget-numbers text-white">
            <span>{formatQty(count)}</span>
          </div>
        </div>
      </div>
    </PlateLink>
  );
}

export function ReturnsWidget({ user }) {
  const [stats, setStats] = useState(EMPTY_RETURNS);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (user?.profileId == null || user?.profileId === '') {
      setStats(EMPTY_RETURNS);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await marketplaceReturnsApi.getStats({ days: 31, marketplace: 'all' });
      setStats({
        waitingCount: data.waitingCount ?? 0,
        countsByMarketplace: data.countsByMarketplace ?? EMPTY_RETURNS.countsByMarketplace,
      });
    } catch {
      setStats(EMPTY_RETURNS);
    } finally {
      setLoading(false);
    }
  }, [user?.profileId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    window.addEventListener('marketplace-returns-stats-refresh', load);
    window.addEventListener('wb-returns-stats-refresh', load);
    return () => {
      clearInterval(t);
      window.removeEventListener('marketplace-returns-stats-refresh', load);
      window.removeEventListener('wb-returns-stats-refresh', load);
    };
  }, [load]);

  const byMp = stats.countsByMarketplace || EMPTY_RETURNS.countsByMarketplace;

  return (
    <PlateLink
      to="/stock-levels/warehouse?op=return_customer"
      title="Открыть возвраты, готовые к выдаче"
      linkClass="home-returns-plate-link"
      blockClass="bg-sunny-morning home-returns-plate-block"
    >
      <div className="widget-content-wrapper text-white home-returns-combined-row">
        <div className="home-returns-combined-left">
          <div className="widget-heading">Возвраты</div>
          <div className="widget-subheading">Готовы к выдаче</div>
        </div>
        <div className="home-returns-combined-mp" role="list" aria-label="По маркетплейсам">
          {MARKETPLACE_TABLE_BADGES.map((mp) => (
            <div key={mp.code} className="home-returns-mp-cell" role="listitem">
              <div className="home-returns-mp-label">{mp.shortLabel}</div>
              <div className="widget-numbers text-white home-returns-mp-count">
                <span>{loading || user?.profileId == null ? '…' : formatQty(byMp[mp.code] ?? 0)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </PlateLink>
  );
}

export function ProductsWidget({ profileId }) {
  const { data, loading } = useStockSummary(profileId);
  return (
    <PlateLink
      to="/products"
      title="Открыть каталог товаров"
      linkClass="home-products-plate-link"
      blockClass="bg-midnight-bloom home-products-plate-block"
    >
      <div className="widget-content-wrapper text-white">
        <div className="widget-content-left">
          <div className="widget-heading">Товары</div>
          <div className="widget-subheading">Всего в системе</div>
        </div>
        <div className="widget-content-right">
          <div className="widget-numbers text-white">
            <span>{loading ? '…' : formatQty(Number(data?.totalProducts) || 0)}</span>
          </div>
        </div>
      </div>
    </PlateLink>
  );
}

export function StockWidget({ profileId }) {
  const { data, loading, error, reload } = useStockSummary(profileId);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailWarehouseId, setDetailWarehouseId] = useState(null);

  const rows = data?.rows ?? [];
  const warehouses = Array.isArray(data?.warehouses) ? data.warehouses : [];
  const totalQty = Number(data?.totalQty) || 0;
  const totalCostSum = Number(data?.totalCostSum) || 0;
  const stockPositionsCount = Number(data?.skusWithStock) || 0;

  const openDetail = (warehouseId = null) => {
    setDetailWarehouseId(warehouseId != null ? String(warehouseId) : null);
    setDetailOpen(true);
  };
  const onKeyOpen = (warehouseId) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openDetail(warehouseId);
    }
  };

  const detailWarehouse =
    detailWarehouseId != null ? warehouses.find((w) => String(w.warehouseId) === String(detailWarehouseId)) : null;
  const detailRows = detailWarehouse?.rows ?? rows;
  const detailQty = detailWarehouse ? Number(detailWarehouse.totalQty) || 0 : totalQty;
  const detailCost = detailWarehouse ? Number(detailWarehouse.totalCostSum) || 0 : totalCostSum;
  const detailSkus = detailWarehouse ? Number(detailWarehouse.skusWithStock) || 0 : stockPositionsCount;
  const detailTitle = detailWarehouse ? `Остатки: ${detailWarehouse.name}` : 'Остатки по категориям';

  return (
    <>
      <div className="card mb-0 h-100 widget-content bg-grow-early home-stock-plate-block" title="Остатки по складам">
        <div className="widget-content-wrapper text-white home-stock-plate-stack">
          <div className="home-stock-plate-head">
            <div className="widget-heading">Остатки</div>
            <div className="widget-subheading">По складам</div>
          </div>
          {loading ? (
            <div className="home-stock-wh-empty">…</div>
          ) : error ? (
            <div className="home-stock-wh-empty">—</div>
          ) : warehouses.length === 0 ? (
            <div
              role="button"
              tabIndex={0}
              className="home-stock-wh-empty"
              onClick={() => openDetail(null)}
              onKeyDown={onKeyOpen(null)}
            >
              Нет складов
            </div>
          ) : (
            <div className="home-stock-wh-list" role="list" aria-label="Остатки по складам">
              {warehouses.map((wh) => {
                const amt = formatRubAmountInt(Number(wh.totalCostSum) || 0);
                return (
                  <div
                    key={wh.warehouseId}
                    role="button"
                    tabIndex={0}
                    className="home-stock-wh-row"
                    onClick={() => openDetail(wh.warehouseId)}
                    onKeyDown={onKeyOpen(wh.warehouseId)}
                    title={`Категории склада «${wh.name}»`}
                  >
                    <div className="home-stock-wh-name">{wh.name}</div>
                    <div className="home-stock-wh-qty">
                      <span className="home-stock-plate-num">{formatQty(Number(wh.totalQty) || 0)}</span>
                      <span className="home-stock-plate-suffix"> шт</span>
                    </div>
                    <div className="home-stock-wh-cost">
                      {amt == null ? (
                        '—'
                      ) : (
                        <>
                          <span className="home-stock-plate-num">{amt}</span>
                          <span className="home-stock-plate-suffix"> руб.</span>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <Modal
        isOpen={detailOpen}
        onClose={() => {
          setDetailOpen(false);
          setDetailWarehouseId(null);
        }}
        title={detailTitle}
        size="large"
      >
        <div className="home-stock-modal-total mb-3" role="status">
          <strong>Итого по себестоимости:</strong> {loading ? '…' : error ? '—' : formatRub(detailCost)}
          <span className="text-muted ms-2">
            · единиц: {loading ? '…' : formatQty(detailQty)}
            {' · '}
            позиций с остатком: {loading ? '…' : formatQty(detailSkus)}
          </span>
        </div>
        {error && (
          <div className="alert alert-danger d-flex flex-wrap align-items-center gap-2" role="alert">
            {error}
            <Button type="button" variant="secondary" size="small" onClick={reload}>
              Повторить
            </Button>
          </div>
        )}
        {!error && loading && <div className="text-muted">Загрузка…</div>}
        {!error && !loading && (
          <div className="table-responsive">
            <table className="align-middle mb-0 table table-striped table-hover">
              <thead>
                <tr>
                  <th>Категория</th>
                  <th className="text-end">Количество</th>
                  <th className="text-end">Сумма себестоимости</th>
                </tr>
              </thead>
              <tbody>
                {detailRows.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="text-center text-muted py-4">
                      Нет товаров
                    </td>
                  </tr>
                ) : (
                  detailRows.map((row) => (
                    <tr key={row.categoryId}>
                      <td>{row.name}</td>
                      <td className="text-end text-nowrap">{formatQty(row.qty)}</td>
                      <td className="text-end text-nowrap">{formatRub(row.costSum)}</td>
                    </tr>
                  ))
                )}
              </tbody>
              {detailRows.length > 0 && (
                <tfoot className="table-group-divider">
                  <tr className="fw-semibold">
                    <td>Всего</td>
                    <td className="text-end">{formatQty(detailQty)}</td>
                    <td className="text-end text-nowrap">{formatRub(detailCost)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </Modal>
    </>
  );
}
