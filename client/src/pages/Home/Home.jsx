/**
 * Home Page
 * Главная страница приложения
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { PageTitle } from '../../components/layout/PageTitle/PageTitle';
import { useAuth } from '../../context/AuthContext.jsx';
import { productsApi } from '../../services/products.api.js';
import { ordersApi } from '../../services/orders.api';
import { questionsApi } from '../../services/questions.api';
import { marketplaceReturnsApi } from '../../services/marketplaceReturns.api';
import { integrationsApi } from '../../services/integrations.api';
import { MARKETPLACE_TABLE_BADGES } from '../../constants/marketplaceUi';
import { MarketplaceInventorySummary } from '../../components/MarketplaceInventorySummary/MarketplaceInventorySummary.jsx';
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

/** К какой организации относится строка баланса (ответ getMarketplaceAccountBalances). */
function marketplaceBalanceOrganizationLine(mp, balanceLoading) {
  if (balanceLoading) return '…';
  if (!mp?.configured) return '—';
  const org = mp.organizationName != null ? String(mp.organizationName).trim() : '';
  if (org && org !== '—') return `Организация: «${org}»`;
  if (mp.keysSource === 'integrations') return 'Общие интеграции профиля (без привязки к организации)';
  if (mp.keysSource === 'marketplace_cabinet') {
    const cab = mp.cabinetName != null ? String(mp.cabinetName).trim() : '';
    if (cab) return `Кабинет: «${cab}»`;
  }
  return '—';
}

/** Сумма в рублях для плашки (целое число; суффикс «руб.» выводим отдельно мелким шрифтом) */
function formatRubAmountInt(n) {
  if (!Number.isFinite(n)) return null;
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0
  }).format(Math.round(n));
}

export function Home() {
  const { isAccountAdmin, user, profileId } = useAuth();
  const [needProcessOrderCount, setNeedProcessOrderCount] = useState(0);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [ordersError, setOrdersError] = useState(null);
  const [stockSummary, setStockSummary] = useState(null);
  const [stockSummaryLoading, setStockSummaryLoading] = useState(true);
  const [stockSummaryError, setStockSummaryError] = useState(null);
  const [stockDetailOpen, setStockDetailOpen] = useState(false);
  const [questionsNewCount, setQuestionsNewCount] = useState(0);
  const [returnsStats, setReturnsStats] = useState({
    waitingCount: 0,
    countsByMarketplace: { ozon: 0, wildberries: 0, yandex: 0 },
  });
  const [returnsLoading, setReturnsLoading] = useState(true);
  const [balanceData, setBalanceData] = useState(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState(null);

  const loadOrderNeedProcessCount = useCallback(async () => {
    setOrdersLoading(true);
    setOrdersError(null);
    try {
      const counts = await ordersApi.getStatusCounts();
      const sum = ORDER_NEED_PROCESS_STATUSES.reduce(
        (acc, st) => acc + (Number(counts?.[st]) || 0),
        0
      );
      setNeedProcessOrderCount(sum);
    } catch (e) {
      setOrdersError(e?.message || 'Не удалось загрузить счётчик заказов');
      setNeedProcessOrderCount(0);
    } finally {
      setOrdersLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOrderNeedProcessCount();
  }, [profileId, loadOrderNeedProcessCount]);

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

  const loadReturnsStats = useCallback(async () => {
    if (user?.profileId == null || user?.profileId === '') {
      setReturnsStats({
        waitingCount: 0,
        countsByMarketplace: { ozon: 0, wildberries: 0, yandex: 0 },
      });
      setReturnsLoading(false);
      return;
    }
    setReturnsLoading(true);
    try {
      const data = await marketplaceReturnsApi.getStats({ days: 31, marketplace: 'all' });
      setReturnsStats({
        waitingCount: data.waitingCount ?? 0,
        countsByMarketplace: data.countsByMarketplace ?? { ozon: 0, wildberries: 0, yandex: 0 },
      });
    } catch {
      setReturnsStats({
        waitingCount: 0,
        countsByMarketplace: { ozon: 0, wildberries: 0, yandex: 0 },
      });
    } finally {
      setReturnsLoading(false);
    }
  }, [user?.profileId]);

  useEffect(() => {
    loadReturnsStats();
    const t = setInterval(loadReturnsStats, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [loadReturnsStats]);

  useEffect(() => {
    const onRefresh = () => loadReturnsStats();
    window.addEventListener('marketplace-returns-stats-refresh', onRefresh);
    window.addEventListener('wb-returns-stats-refresh', onRefresh);
    return () => {
      window.removeEventListener('marketplace-returns-stats-refresh', onRefresh);
      window.removeEventListener('wb-returns-stats-refresh', onRefresh);
    };
  }, [loadReturnsStats]);

  const loadMarketplaceBalances = useCallback(async () => {
    if (profileId == null) {
      setBalanceData(null);
      setBalanceError(null);
      return;
    }
    setBalanceLoading(true);
    setBalanceError(null);
    try {
      const d = await integrationsApi.getMarketplaceAccountBalances();
      setBalanceData(d);
    } catch (e) {
      const msg =
        e?.response?.data?.message ||
        e?.response?.data?.error ||
        e?.message ||
        'Не удалось загрузить балансы';
      setBalanceError(msg);
      setBalanceData(null);
    } finally {
      setBalanceLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    loadMarketplaceBalances();
  }, [loadMarketplaceBalances]);

  const loadStockSummary = useCallback(() => {
    setStockSummaryLoading(true);
    setStockSummaryError(null);
    return productsApi
      .getHomeStockSummary()
      .then((data) => setStockSummary(data || null))
      .catch((e) => {
        setStockSummaryError(
          e?.response?.data?.message || e?.message || 'Не удалось загрузить сводку остатков'
        );
        setStockSummary(null);
      })
      .finally(() => setStockSummaryLoading(false));
  }, []);

  useEffect(() => {
    loadStockSummary();
  }, [profileId, loadStockSummary]);

  /** Верхний ряд: заказы, вопросы, возвраты; ниже — товары и остатки */
  const opsWidgetColClass = 'col-12 col-md-4';
  const stockWidgetColClass = 'col-12 col-md-6';

  const rows = stockSummary?.rows ?? [];
  const totalQty = Number(stockSummary?.totalQty) || 0;
  const totalCostSum = Number(stockSummary?.totalCostSum) || 0;
  const stockPositionsCount = Number(stockSummary?.skusWithStock) || 0;
  const totalProductsCount = Number(stockSummary?.totalProducts) || 0;
  const stockLoading = stockSummaryLoading;
  const stockError = stockSummaryError;
  const returnsByMp = returnsStats.countsByMarketplace || { ozon: 0, wildberries: 0, yandex: 0 };

  return (
    <div>
      <PageTitle
        iconClass="pe-7s-home"
        iconBgClass="bg-mean-fruit"
        title="Главная"
        subtitle="Сводка по заказам, вопросам, возвратам и остаткам"
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

      <div className="home-dashboard-widgets">
        <div className="row g-3 home-dashboard-top-widgets mb-3">
          <div className={opsWidgetColClass}>
            <Link
              to="/orders"
              className="text-decoration-none d-block home-orders-plate-link"
              title="Открыть заказы"
            >
              <div className="card mb-3 widget-content bg-arielle-smile home-orders-plate-block">
                <div className="widget-content-wrapper text-white">
                  <div className="widget-content-left">
                    <div className="widget-heading">Заказы</div>
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
            </Link>
          </div>
          <div className={opsWidgetColClass}>
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
          <div className={opsWidgetColClass}>
            <Link
              to="/stock-levels/warehouse?op=return_customer"
              className="text-decoration-none d-block home-returns-plate-link"
              title="Открыть возвраты, готовые к выдаче"
            >
              <div className="card mb-3 widget-content bg-sunny-morning home-returns-plate-block">
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
                          <span>
                            {returnsLoading || user?.profileId == null ? '…' : formatQty(returnsByMp[mp.code] ?? 0)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Link>
          </div>
        </div>

        <div className="row g-3 home-dashboard-stock-widgets mb-3">
          <div className={isAccountAdmin ? stockWidgetColClass : 'col-12'}>
            <Link
              to="/products"
              className="text-decoration-none d-block home-products-plate-link"
              title="Открыть каталог товаров"
            >
              <div className="card mb-3 widget-content bg-midnight-bloom home-products-plate-block">
                <div className="widget-content-wrapper text-white">
                  <div className="widget-content-left">
                    <div className="widget-heading">Товары</div>
                    <div className="widget-subheading">Всего в системе</div>
                  </div>
                  <div className="widget-content-right">
                    <div className="widget-numbers text-white">
                      <span>{stockLoading ? '…' : formatQty(totalProductsCount)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </Link>
          </div>
          {isAccountAdmin && (
            <div className={stockWidgetColClass}>
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
                    <div className="widget-subheading">На складе</div>
                  </div>
                  <div className="widget-numbers text-white home-stock-plate-col-center">
                    {stockLoading ? '…' : stockError ? '—' : (
                      <>
                        <span className="home-stock-plate-num">{formatQty(totalQty)}</span>
                        <span className="home-stock-plate-suffix"> шт</span>
                      </>
                    )}
                  </div>
                  <div className="widget-numbers text-white home-stock-plate-col-right">
                    {stockLoading ? '…' : stockError ? '—' : (() => {
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
          <div className="row mb-3">
            <div className="col-12">
              <MarketplaceInventorySummary visible />
            </div>
          </div>
        )}
      </div>

      {isAccountAdmin && user && (
        <div className="row mb-3">
          <div className="col-12">
            <div className="card home-marketplace-balances-card">
              <div className="card-header d-flex flex-wrap align-items-center justify-content-between gap-2">
                <div className="card-header-title mb-0">
                  <i className="header-icon pe-7s-wallet icon-gradient bg-mean-fruit me-2" />
                  Баланс на маркетплейсах
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  className="btn-wide"
                  disabled={balanceLoading || profileId == null}
                  onClick={() => loadMarketplaceBalances()}
                >
                  {balanceLoading ? 'Загрузка…' : 'Обновить'}
                </Button>
              </div>
              <div className="card-body">
                <p className="text-muted small mb-3">
                  Ключи API — из общих интеграций профиля или из кабинета организации («Интеграции»). Если кабинетов
                  несколько, для цифр берётся один кабинет на маркетплейс (первый по названию организации и порядку
                  кабинета). Под названием маркетплейса указано, к какой организации относятся данные. Ozon — отчёт
                  «Движение средств» за текущий месяц; Wildberries — баланс из Finance API (категория «Финансы»),
                  дополнительные суммы из ответа API при наличии; Яндекс Маркет — рублёвого баланса в API нет,
                  показываются данные магазина по campaign_id.
                </p>
                {profileId == null && (
                  <div className="text-muted mb-0" role="status">
                    Балансы запрашиваются в контексте аккаунта (профиля). У текущего пользователя нет привязки к
                    профилю — укажите её в настройках или зайдите под пользователем аккаунта.
                  </div>
                )}
                {profileId != null && balanceError && (
                  <div className="alert alert-warning py-2 mb-3" role="alert">
                    {balanceError}
                  </div>
                )}
                {profileId != null && balanceData?.no_profile && (
                  <div className="text-muted">Нет привязки к аккаунту — балансы недоступны.</div>
                )}
                {profileId != null && !balanceData?.no_profile && (
                  <div className="table-responsive">
                    <table className="align-middle mb-0 table table-striped table-hover">
                      <thead>
                        <tr>
                          <th className="home-balance-mp-col">Маркетплейс</th>
                          <th className="text-end">Баланс</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="home-balance-mp-col">
                            <div>Ozon</div>
                            <div className="text-muted small mt-1">
                              {marketplaceBalanceOrganizationLine(balanceData?.ozon, balanceLoading)}
                            </div>
                          </td>
                          <td className="text-end">
                            {balanceLoading ? (
                              '…'
                            ) : !balanceData?.ozon?.configured ? (
                              <div className="text-muted small text-end">
                                <div className="mb-1">
                                  Не найдены <strong>Client ID</strong> и <strong>API Key</strong> Ozon ни в общих
                                  настройках профиля, ни в кабинетах организаций.
                                </div>
                                <Link to="/integrations">Открыть интеграции</Link>
                              </div>
                            ) : balanceData.ozon.error ? (
                              <span className="text-danger small">{balanceData.ozon.error}</span>
                            ) : balanceData.ozon.amountRub != null && Number.isFinite(Number(balanceData.ozon.amountRub)) ? (
                              <span className="text-nowrap">{formatRub(Number(balanceData.ozon.amountRub))}</span>
                            ) : (
                              <span className="text-muted">Нет данных в отчёте</span>
                            )}
                          </td>
                        </tr>
                        <tr>
                          <td className="home-balance-mp-col">
                            <div>Wildberries</div>
                            <div className="text-muted small mt-1">
                              {marketplaceBalanceOrganizationLine(balanceData?.wildberries, balanceLoading)}
                            </div>
                          </td>
                          <td className="text-end">
                            {balanceLoading ? (
                              '…'
                            ) : !balanceData?.wildberries?.configured ? (
                              <div className="text-muted small text-end">
                                <div className="mb-1">
                                  Не найден <strong>API-токен</strong> Wildberries в настройках профиля или в кабинетах
                                  организаций. Для баланса нужен токен с категорией <strong>«Финансы»</strong>.
                                </div>
                                <Link to="/integrations">Открыть интеграции</Link>
                              </div>
                            ) : balanceData.wildberries.error ? (
                              <span className="text-danger small">{balanceData.wildberries.error}</span>
                            ) : (
                              <div className="d-inline-block text-end">
                                <div className="text-nowrap">
                                  <span className="text-muted small me-1">На счёте:</span>
                                  {formatRub(Number(balanceData.wildberries.currentRub))}
                                </div>
                                {balanceData.wildberries.forWithdrawRub != null &&
                                  Number.isFinite(Number(balanceData.wildberries.forWithdrawRub)) && (
                                    <div className="text-nowrap">
                                      <span className="text-muted small me-1">К выводу:</span>
                                      {formatRub(Number(balanceData.wildberries.forWithdrawRub))}
                                    </div>
                                  )}
                                {(balanceData.wildberries.extraAmounts ?? []).map((row) => (
                                  <div key={row.key} className="text-nowrap small" title={row.key}>
                                    <span className="text-muted me-1">{row.label}:</span>
                                    {formatRub(Number(row.amountRub))}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                        <tr>
                          <td className="home-balance-mp-col">
                            <div>Яндекс Маркет</div>
                            <div className="text-muted small mt-1">
                              {marketplaceBalanceOrganizationLine(balanceData?.yandex, balanceLoading)}
                            </div>
                          </td>
                          <td className="text-end">
                            {balanceLoading ? (
                              '…'
                            ) : !balanceData?.yandex?.configured ? (
                              <div className="text-muted small text-end">
                                <div className="mb-1">
                                  Не найден <strong>Api-Key</strong> Partner API Яндекс.Маркета в настройках профиля
                                  или в кабинетах организаций.
                                </div>
                                <Link to="/integrations">Открыть интеграции</Link>
                              </div>
                            ) : (
                              <div className="d-inline-block text-end">
                                {balanceData.yandex.snapshotError && (
                                  <div className="text-warning small mb-1">{balanceData.yandex.snapshotError}</div>
                                )}
                                {balanceData.yandex.campaignSnapshot && (
                                  <div className="small text-end">
                                    {balanceData.yandex.campaignSnapshot.businessName && (
                                      <div className="fw-semibold">{balanceData.yandex.campaignSnapshot.businessName}</div>
                                    )}
                                    {balanceData.yandex.campaignSnapshot.domain && (
                                      <div className="text-muted">{balanceData.yandex.campaignSnapshot.domain}</div>
                                    )}
                                    {(balanceData.yandex.campaignSnapshot.placementType ||
                                      balanceData.yandex.campaignSnapshot.campaignId != null) && (
                                      <div className="text-muted">
                                        {balanceData.yandex.campaignSnapshot.placementType && (
                                          <span>{balanceData.yandex.campaignSnapshot.placementType}</span>
                                        )}
                                        {balanceData.yandex.campaignSnapshot.placementType &&
                                          balanceData.yandex.campaignSnapshot.campaignId != null &&
                                          ' · '}
                                        {balanceData.yandex.campaignSnapshot.campaignId != null && (
                                          <span>ID {balanceData.yandex.campaignSnapshot.campaignId}</span>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                )}
                                <div className="text-muted small mt-1">{balanceData.yandex.message}</div>
                              </div>
                            )}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {isAccountAdmin && (
        <Modal
          isOpen={stockDetailOpen}
          onClose={() => setStockDetailOpen(false)}
          title="Остатки по категориям"
          size="large"
        >
          <div className="home-stock-modal-total mb-3" role="status">
            <strong>Итого по себестоимости:</strong>{' '}
            {stockLoading ? '…' : stockError ? '—' : formatRub(totalCostSum)}
            <span className="text-muted ms-2">
              · единиц: {stockLoading ? '…' : formatQty(totalQty)}
              {' · '}
              позиций с остатком: {stockLoading ? '…' : formatQty(stockPositionsCount)}
            </span>
          </div>
          {stockError && (
            <div className="alert alert-danger d-flex flex-wrap align-items-center gap-2" role="alert">
              {stockError}
              <Button type="button" variant="secondary" size="small" onClick={() => loadStockSummary()}>
                Повторить
              </Button>
            </div>
          )}
          {!stockError && stockLoading && <div className="text-muted">Загрузка…</div>}
          {!stockError && !stockLoading && (
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
