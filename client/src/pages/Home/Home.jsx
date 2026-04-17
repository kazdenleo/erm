/**
 * Home Page
 * Главная страница приложения
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { PageTitle } from '../../components/layout/PageTitle/PageTitle';
import { useAuth } from '../../context/AuthContext.jsx';
import { useProducts } from '../../hooks/useProducts';
import { useOrders } from '../../hooks/useOrders';
import { questionsApi } from '../../services/questions.api';
import { countOrderGroupsWithStatuses } from '../../utils/orderListGroupKey';
import './Home.css';

/** Плашка «Нужно обработать»: новые + на сборке (ещё не «Собран») */
const ORDER_NEED_PROCESS_STATUSES = ['new', 'in_assembly', 'wb_assembly'];

function formatRub(n) {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 2,
    minimumFractionDigits: 0
  }).format(n);
}

function formatQty(n) {
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n));
}

/** Сумма в рублях для плашки (целое число; суффикс «руб.» выводим отдельно мелким шрифтом) */
function formatRubAmountInt(n) {
  if (!Number.isFinite(n)) return null;
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0
  }).format(Math.round(n));
}

function categoryLabel(p) {
  const name = (p.category_name || p.categoryName || '').trim();
  if (name) return name;
  return 'Без категории';
}

function aggregateStocksByCategory(products) {
  const list = Array.isArray(products) ? products : [];
  const map = new Map();
  let totalQty = 0;
  let totalCostSum = 0;

  for (const p of list) {
    const qty = Math.max(0, Number(p.quantity) || 0);
    const unitCost = p.cost != null && p.cost !== '' ? Number(p.cost) : null;
    const lineCost = unitCost != null && Number.isFinite(unitCost) ? qty * unitCost : 0;

    totalQty += qty;
    totalCostSum += lineCost;

    const cid =
      p.categoryId != null && String(p.categoryId).trim() !== ''
        ? String(p.categoryId)
        : '_none';
    const label = categoryLabel(p);

    if (!map.has(cid)) {
      map.set(cid, { categoryId: cid, name: label, qty: 0, costSum: 0 });
    }
    const row = map.get(cid);
    row.qty += qty;
    row.costSum += lineCost;
  }

  const rows = [...map.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' })
  );

  return { rows, totalQty, totalCostSum };
}

/** Позиций с ненулевым остатком на складе */
function countSkusWithStock(products) {
  const list = Array.isArray(products) ? products : [];
  return list.filter((p) => (Number(p.quantity) || 0) > 0).length;
}

export function Home() {
  const { isAccountAdmin, user } = useAuth();
  const { products, loading, error, loadProducts } = useProducts();
  const { orders, loading: ordersLoading, error: ordersError } = useOrders();
  const [stockDetailOpen, setStockDetailOpen] = useState(false);
  const [questionsNewCount, setQuestionsNewCount] = useState(0);

  const loadQuestionsStats = useCallback(async () => {
    if (user?.profileId == null || user?.profileId === '') {
      setQuestionsNewCount(0);
      return;
    }
    try {
      const { newCount } = await questionsApi.getStats();
      setQuestionsNewCount(
        typeof newCount === 'number' && Number.isFinite(newCount) ? newCount : 0
      );
    } catch {
      setQuestionsNewCount(0);
    }
  }, [user?.profileId]);

  useEffect(() => {
    loadQuestionsStats();
    const t = setInterval(loadQuestionsStats, 60000);
    return () => clearInterval(t);
  }, [loadQuestionsStats]);

  useEffect(() => {
    const onRefresh = () => loadQuestionsStats();
    window.addEventListener('questions-stats-refresh', onRefresh);
    return () => window.removeEventListener('questions-stats-refresh', onRefresh);
  }, [loadQuestionsStats]);

  const widgetColClass = isAccountAdmin ? 'col-md-6 col-xl-3' : 'col-md-6 col-xl-4';

  const needProcessOrderCount = useMemo(
    () => countOrderGroupsWithStatuses(orders, ORDER_NEED_PROCESS_STATUSES),
    [orders]
  );

  const { rows, totalQty, totalCostSum } = useMemo(
    () => aggregateStocksByCategory(products),
    [products]
  );

  const stockPositionsCount = useMemo(() => countSkusWithStock(products), [products]);

  return (
    <div>
      <PageTitle
        iconClass="pe-7s-graph2"
        iconBgClass="bg-mean-fruit"
        title="Analytics Dashboard"
        subtitle="Это страница-дашборд в стиле ArchitectUI (как на демо)."
        actions={(
          <>
            <Button className="btn-shadow me-2" variant="secondary" size="small">
              <i className="fa fa-star me-2" /> Избранное
            </Button>
            <Button className="btn-shadow" variant="info" size="small">
              <i className="fa fa-business-time me-2" /> Действия
            </Button>
          </>
        )}
      />

      <div className="row">
        <div className={widgetColClass}>
          <div className="card mb-3 widget-content bg-midnight-bloom">
            <div className="widget-content-wrapper text-white">
              <div className="widget-content-left">
                <div className="widget-heading">Товары</div>
                <div className="widget-subheading">Всего в системе</div>
              </div>
              <div className="widget-content-right">
                <div className="widget-numbers text-white">
                  <span>{loading ? '…' : formatQty(products.length)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className={widgetColClass}>
          <div className="card mb-3 widget-content bg-arielle-smile">
            <div className="widget-content-wrapper text-white">
              <div className="widget-content-left">
                <div className="widget-heading">Нужно обработать</div>
                <div className="widget-subheading">Новые и на сборке</div>
              </div>
              <div className="widget-content-right">
                <div className="widget-numbers text-white">
                  <span>
                    {ordersLoading ? '…' : ordersError ? '—' : formatQty(needProcessOrderCount)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className={widgetColClass}>
          <Link
            to="/questions"
            className="text-decoration-none d-block home-questions-plate-link"
            title="Открыть вопросы покупателей"
          >
            <div className="card mb-3 widget-content bg-malibu-beach home-questions-plate-block">
              <div className="widget-content-wrapper text-white">
                <div className="widget-content-left">
                  <div className="widget-heading">Обработать вопросов</div>
                  <div className="widget-subheading">Без ответа продавца</div>
                </div>
                <div className="widget-content-right">
                  <div className="widget-numbers text-white">
                    <span>{formatQty(questionsNewCount)}</span>
                  </div>
                </div>
              </div>
            </div>
          </Link>
        </div>
        {isAccountAdmin && (
          <div className={widgetColClass}>
            <div
              role="button"
              tabIndex={0}
              className="card mb-3 widget-content bg-grow-early home-stock-plate-block"
              onClick={() => setStockDetailOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setStockDetailOpen(true);
                }
              }}
              aria-haspopup="dialog"
              aria-expanded={stockDetailOpen}
              title="Открыть остатки по категориям"
            >
              <div className="widget-content-wrapper text-white home-stock-plate-row">
                <div className="widget-content-left">
                  <div className="widget-heading">Остатки</div>
                </div>
                <div className="widget-numbers text-white home-stock-plate-col-center">
                  {loading ? '…' : error ? '—' : (
                    <>
                      <span className="home-stock-plate-num">{formatQty(totalQty)}</span>
                      <span className="home-stock-plate-suffix"> шт</span>
                    </>
                  )}
                </div>
                <div className="widget-numbers text-white home-stock-plate-col-right">
                  {loading ? '…' : error ? '—' : (() => {
                    const amt = formatRubAmountInt(totalCostSum);
                    return amt == null ? '—' : (
                      <>
                        <span className="home-stock-plate-num">{amt}</span>
                        <span className="home-stock-plate-suffix"> руб.</span>
                      </>
                    );
                  })()}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {isAccountAdmin && (
        <Modal
          isOpen={stockDetailOpen}
          onClose={() => setStockDetailOpen(false)}
          title="Остатки по категориям"
          size="large"
        >
          <div className="home-stock-modal-total mb-3" role="status">
            <strong>Итого по себестоимости:</strong>{' '}
            {loading ? '…' : error ? '—' : formatRub(totalCostSum)}
            <span className="text-muted ms-2">
              · единиц: {loading ? '…' : formatQty(totalQty)}
              {' · '}
              позиций с остатком: {loading ? '…' : formatQty(stockPositionsCount)}
            </span>
          </div>
          {error && (
            <div className="alert alert-danger d-flex flex-wrap align-items-center gap-2" role="alert">
              {error}
              <Button type="button" variant="secondary" size="small" onClick={() => loadProducts()}>
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
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="text-center text-muted py-4">
                        Нет товаров
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => (
                      <tr key={row.categoryId}>
                        <td>{row.name}</td>
                        <td className="text-end text-nowrap">{formatQty(row.qty)}</td>
                        <td className="text-end text-nowrap">{formatRub(row.costSum)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
                {rows.length > 0 && (
                  <tfoot className="table-group-divider">
                    <tr className="fw-semibold">
                      <td>Всего</td>
                      <td className="text-end">{formatQty(totalQty)}</td>
                      <td className="text-end text-nowrap">{formatRub(totalCostSum)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </Modal>
      )}

      <div className="row">
        <div className="col-md-12 col-lg-6">
          <div className="mb-3 card">
            <div className="card-header-tab card-header-tab-animation card-header">
              <div className="card-header-title">
                <i className="header-icon lnr-apartment icon-gradient bg-love-kiss" /> Sales Report
              </div>
              <div className="btn-actions-pane-right">
                <div className="nav" role="tablist">
                  <Button className="btn-pill btn-wide btn-transition active me-1" variant="secondary" size="small">Last</Button>
                  <Button className="btn-pill btn-wide btn-transition" variant="secondary" size="small">Current</Button>
                </div>
              </div>
            </div>
            <div className="card-body">
              <div className="text-muted small">
                Здесь будет график/виджеты — сейчас оставил блок как на демо, но данные подключим позже.
              </div>
              <div className="mt-3 d-flex gap-2 flex-wrap">
                <Button variant="primary" size="small">Добавить товар</Button>
                <Button variant="secondary" size="small">Создать заказ</Button>
                <Button variant="success" size="small">Синхронизировать</Button>
              </div>
            </div>
          </div>
        </div>

        <div className="col-md-12 col-lg-6">
          <div className="mb-3 card">
            <div className="card-header">
              Active Users
              <div className="btn-actions-pane-right">
                <div role="group" className="btn-group-sm btn-group">
                  <Button className="active" variant="secondary" size="small">Last Week</Button>
                  <Button variant="secondary" size="small">All Month</Button>
                </div>
              </div>
            </div>
            <div className="table-responsive">
              <table className="align-middle mb-0 table table-borderless table-striped table-hover">
                <thead>
                  <tr>
                    <th className="text-center">#</th>
                    <th>Событие</th>
                    <th className="text-center">Статус</th>
                    <th className="text-center">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="text-center text-muted">#—</td>
                    <td>Пример строки</td>
                    <td className="text-center"><div className="badge bg-warning">Pending</div></td>
                    <td className="text-center"><Button variant="primary" size="small">Details</Button></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="d-block text-center card-footer">
              <Button className="btn-wide" variant="success" size="small">Save</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
