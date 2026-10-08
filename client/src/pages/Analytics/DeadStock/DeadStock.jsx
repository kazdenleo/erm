/**
 * Неликвиды и замороженные деньги: товары без продаж и излишки, что выгоднее — скидка, вывоз с FBO или ждать.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { salesAnalyticsApi } from '../../../services/salesAnalytics.api';
import { SortableTh, sortRows, useTableSort } from '../shared/tableSort';
import {
  Badge,
  NumberFilter,
  ProductCell,
  SummaryCards,
  ToggleGroup,
  errorMessage,
  formatDateRu,
  formatPercent,
  formatQty,
  formatRub,
  marketplaceLabel,
} from '../shared/analyticsKit';
import '../SalesAnalytics/SalesAnalytics.css';
import '../ProductDynamics/ProductDynamics.css';

const REC_TONES = { remove_fbo: 'purple', discount: 'warning', keep: 'neutral' };

const SORT_GETTERS = {
  product: (r) => r.productSku || '',
  totalQty: (r) => Number(r.totalQty) || 0,
  stockCost: (r) => Number(r.stockCost) || 0,
  daysSinceSale: (r) => (r.daysSinceSale == null ? Number.POSITIVE_INFINITY : Number(r.daysSinceSale)),
  ratePerDay: (r) => Number(r.ratePerDay) || 0,
  coverageDays: (r) => (r.coverageDays == null ? Number.POSITIVE_INFINITY : Number(r.coverageDays)),
  excessCost: (r) => Number(r.excessCost) || 0,
  fboStoragePerMonth: (r) => Number(r.fboStoragePerMonth) || 0,
  holdCost: (r) => Number(r.holdCost) || 0,
  removalCost: (r) => Number(r.removalCost) || 0,
  breakEvenDiscountPct: (r) => (r.breakEvenDiscountPct == null ? -1 : Number(r.breakEvenDiscountPct)),
  recommendation: (r) => r.recommendation?.code || '',
};

export function DeadStock() {
  const [noSalesDays, setNoSalesDays] = useState('60');
  const [horizonDays, setHorizonDays] = useState('90');
  const [storagePerLiterDay, setStoragePerLiterDay] = useState('0.1');
  const [removalPerUnit, setRemovalPerUnit] = useState('50');
  const [capitalRatePercent, setCapitalRatePercent] = useState('20');
  const [kind, setKind] = useState('all');
  const [rec, setRec] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const { sort, toggleSort } = useTableSort('excessCost', 'desc');

  // Параметры применяются кнопкой «Рассчитать», а не на каждое нажатие клавиши
  const [applied, setApplied] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    salesAnalyticsApi
      .getDeadStock(applied || {})
      .then((res) => {
        if (!cancelled) setData(res?.data ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e, 'Не удалось рассчитать неликвиды'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied]);

  const reload = useCallback(() => {
    setApplied({ noSalesDays, horizonDays, storagePerLiterDay, removalPerUnit, capitalRatePercent });
  }, [noSalesDays, horizonDays, storagePerLiterDay, removalPerUnit, capitalRatePercent]);

  const all = useMemo(() => (Array.isArray(data?.items) ? data.items : []), [data]);
  const items = useMemo(
    () =>
      all.filter((r) => {
        if (kind === 'dead' && !r.dead) return false;
        if (kind === 'excess' && r.dead) return false;
        if (rec !== 'all' && r.recommendation?.code !== rec) return false;
        return true;
      }),
    [all, kind, rec]
  );
  const sorted = useMemo(() => sortRows(items, sort, SORT_GETTERS), [items, sort]);
  const summary = data?.summary || {};
  const byRec = summary.byRecommendation || {};
  const params = data?.params || {};
  const fboDays = data?.fboSnapshotDay || {};

  return (
    <div className="sales-analytics">
      <PageTitle
        iconClass="pe-7s-box1"
        iconBgClass="bg-arielle-smile"
        title="Неликвиды и замороженные деньги"
        subtitle="Товары без продаж и излишки запаса: сколько в них вложено и что с ними выгоднее сделать"
      />

      <div className="sales-analytics__filters erp-filter-bar">
        <NumberFilter
          label="Без продаж, дн."
          value={noSalesDays}
          onChange={setNoSalesDays}
          min={7}
          width={80}
          title="Товар считается неликвидом, если за это число дней не было ни одной продажи"
        />
        <NumberFilter
          label="Горизонт, дн."
          value={horizonDays}
          onChange={setHorizonDays}
          min={14}
          width={80}
          title="Запас сверх продаж за этот срок считается излишком; за этот же срок считается стоимость удержания"
        />
        <NumberFilter
          label="Хранение FBO, ₽/л/день"
          value={storagePerLiterDay}
          onChange={setStoragePerLiterDay}
          step={0.01}
          width={90}
        />
        <NumberFilter label="Вывоз с FBO, ₽/шт" value={removalPerUnit} onChange={setRemovalPerUnit} width={80} />
        <NumberFilter
          label="Стоимость денег, %/год"
          value={capitalRatePercent}
          onChange={setCapitalRatePercent}
          width={70}
          title="Сколько приносили бы деньги, если бы не были заморожены в товаре (ставка кредита или депозита)"
        />
        <Button variant="primary" size="small" onClick={reload} disabled={loading}>
          {loading ? 'Расчёт…' : 'Рассчитать'}
        </Button>
      </div>

      {error && <div className="sales-analytics__error">{error}</div>}

      {data && (
        <SummaryCards
          cards={[
            {
              label: 'Всего в запасах',
              value: formatRub(summary.totalStockCost),
              sub: `свой склад ${formatRub(summary.ownStockCost)} · FBO ${formatRub(summary.fboStockCost)}`,
            },
            {
              label: `Неликвид (нет продаж ${params.noSalesDays || noSalesDays} дн.)`,
              value: formatRub(summary.deadCost),
              tone: 'danger',
              sub: `${formatQty(summary.deadCount, 0)} товаров`,
            },
            {
              label: `Излишки (> ${params.horizonDays || horizonDays} дн. продаж)`,
              value: formatRub(summary.excessCost),
              tone: 'warning',
              sub: `${formatQty(summary.excessCount, 0)} товаров`,
            },
            {
              label: 'Хранение на FBO',
              value: `${formatRub(summary.fboStorageMonth)}/мес`,
              title: 'Оценка по объёму товара и ставке хранения',
            },
            {
              label: 'Цена удержания',
              value: formatRub(summary.holdCostHorizon),
              sub: `за ${params.horizonDays || horizonDays} дн.: хранение + стоимость денег`,
            },
          ]}
        />
      )}

      <div className="product-dynamics__controls-row">
        <ToggleGroup
          label="Тип"
          value={kind}
          onChange={setKind}
          disabled={!data}
          options={[
            { value: 'all', label: 'Все', count: all.length },
            { value: 'dead', label: 'Неликвид', count: all.filter((r) => r.dead).length },
            { value: 'excess', label: 'Излишки', count: all.filter((r) => !r.dead).length },
          ]}
        />
        <ToggleGroup
          label="Рекомендация"
          value={rec}
          onChange={setRec}
          disabled={!data}
          options={[
            { value: 'all', label: 'Все' },
            { value: 'remove_fbo', label: 'Вывезти с FBO', count: byRec.remove_fbo || 0 },
            { value: 'discount', label: 'Снизить цену', count: byRec.discount || 0 },
            { value: 'keep', label: 'Оставить', count: byRec.keep || 0 },
          ]}
        />
      </div>

      <div className="sales-analytics__table-wrap" style={{ marginTop: 12 }}>
        <table className="sales-analytics__table">
          <thead>
            <tr>
              <SortableTh sortKey="product" sort={sort} onSort={toggleSort}>
                Товар
              </SortableTh>
              <SortableTh sortKey="totalQty" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Остаток
              </SortableTh>
              <SortableTh sortKey="stockCost" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Вложено
              </SortableTh>
              <SortableTh sortKey="daysSinceSale" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Посл. продажа
              </SortableTh>
              <SortableTh sortKey="coverageDays" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Хватит на, дн.
              </SortableTh>
              <SortableTh sortKey="excessCost" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Излишек
              </SortableTh>
              <SortableTh sortKey="holdCost" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Удержание
              </SortableTh>
              <SortableTh sortKey="removalCost" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Вывоз
              </SortableTh>
              <SortableTh
                sortKey="breakEvenDiscountPct"
                sort={sort}
                onSort={toggleSort}
                className="sales-analytics__num"
                title="Скидка, при которой продать сейчас выгоднее, чем держать излишек весь горизонт"
              >
                Окупаемая скидка
              </SortableTh>
              <SortableTh sortKey="recommendation" sort={sort} onSort={toggleSort}>
                Что делать
              </SortableTh>
            </tr>
          </thead>
          <tbody>
            {!loading && data != null && sorted.length === 0 && (
              <tr>
                <td colSpan={10} className="sales-analytics__empty">
                  Неликвидов и излишков нет
                </td>
              </tr>
            )}
            {sorted.map((r) => {
              const fboParts = Object.entries(r.fboQty || {}).filter(([, q]) => Number(q) > 0);
              return (
                <tr key={r.productId}>
                  <td>
                    <ProductCell sku={r.productSku} name={r.productName} />
                  </td>
                  <td className="sales-analytics__num">
                    {formatQty(r.totalQty, 0)}
                    <div className="analytics-kit__product-name">
                      свой {formatQty(r.ownQty, 0)}
                      {fboParts.map(([mp, q]) => ` · ${marketplaceLabel(mp)} ${formatQty(q, 0)}`).join('')}
                    </div>
                  </td>
                  <td className="sales-analytics__num">{formatRub(r.stockCost)}</td>
                  <td className="sales-analytics__num">
                    {r.lastSaleDate ? (
                      <>
                        {formatDateRu(r.lastSaleDate)}
                        <div className="analytics-kit__product-name">{formatQty(r.daysSinceSale, 0)} дн. назад</div>
                      </>
                    ) : (
                      'не было'
                    )}
                  </td>
                  <td className="sales-analytics__num">{r.coverageDays == null ? '∞' : formatQty(r.coverageDays, 0)}</td>
                  <td className="sales-analytics__num">
                    {formatRub(r.excessCost)}
                    <div className="analytics-kit__product-name">{formatQty(r.excessUnits, 0)} шт</div>
                  </td>
                  <td className="sales-analytics__num" title={`Хранение ${formatRub(r.storageExcessHorizon)} + деньги ${formatRub(r.capitalCost)}`}>
                    {formatRub(r.holdCost)}
                  </td>
                  <td className="sales-analytics__num">{Number(r.removalCost) > 0 ? formatRub(r.removalCost) : '—'}</td>
                  <td className="sales-analytics__num">
                    {r.breakEvenDiscountPct == null ? '—' : formatPercent(r.breakEvenDiscountPct)}
                  </td>
                  <td className="analytics-kit__hint-cell">
                    <Badge tone={REC_TONES[r.recommendation?.code] || 'neutral'}>{r.recommendation?.label}</Badge>
                    <div>{r.recommendation?.hint}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="sales-analytics__hint">
        Остаток — свой склад и последний снимок складов маркетплейсов (Ozon {formatDateRu(fboDays.ozon)}, WB{' '}
        {formatDateRu(fboDays.wb)}, ЯМ {formatDateRu(fboDays.ym)}). Продажи — заказы и финотчёты, продажи комплектов
        разнесены на комплектующие. Излишек = остаток − продажи за горизонт. «Вывезти с FBO» — когда хранение излишка
        дороже вывоза; «Снизить цену» — нет продаж или скидка от 5% окупается за счёт удержания; иначе «Оставить».
      </p>
    </div>
  );
}
