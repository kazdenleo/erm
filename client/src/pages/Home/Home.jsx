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
import { integrationsApi } from '../../services/integrations.api';
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
  const { isAccountAdmin, user, profileId } = useAuth();
  const { products, loading, error, loadProducts } = useProducts();
  const { orders, loading: ordersLoading, error: ordersError } = useOrders();
  const [stockDetailOpen, setStockDetailOpen] = useState(false);
  const [questionsNewCount, setQuestionsNewCount] = useState(0);
  const [balanceData, setBalanceData] = useState(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState(null);

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

  /** col-12 — ниже md плашки в столбик; иначе без xs-класса третья колонка могла обрезаться/уезжать за край */
  const widgetColClass = isAccountAdmin
    ? 'col-12 col-md-6 col-xl-3'
    : 'col-12 col-md-6 col-xl-4';

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

      <div className="row g-3 home-dashboard-top-widgets">
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

      {user && (
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
