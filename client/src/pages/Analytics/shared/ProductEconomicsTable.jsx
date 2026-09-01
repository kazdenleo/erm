import React, { useMemo } from 'react';
import { AmountCell } from './AmountCell';
import { marketplaceRevenueAmount } from './orderEconomics';
import { SortableTh, sortRows, useTableSort } from './tableSort';

function formatQty(n) {
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n));
}

function formatRub(n) {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(n);
}

function otherDeductions(row) {
  return (
    (Number(row.penaltyAmount) || 0) +
    (Number(row.acquiringAmount) || 0) +
    (Number(row.otherDeductions) || 0)
  );
}

const PRODUCT_SORT_GETTERS = {
  productName: (r) => r.productName || '',
  erpSku: (r) => r.erpSku || '',
  soldQty: (r) => Number(r.soldQty) || 0,
  soldAmount: (r) => Number(r.soldAmount) || 0,
  commissionAmount: (r) => Number(r.commissionAmount) || 0,
  logisticsAmount: (r) => Number(r.logisticsAmount) || 0,
  storageAmount: (r) => Number(r.storageAmount) || 0,
  otherDeductions: (r) => otherDeductions(r),
  payoutAmount: (r) => Number(r.payoutAmount) || 0,
  costAmount: (r) => Number(r.costAmount) || 0,
  additionalExpensesAmount: (r) => Number(r.additionalExpensesAmount) || 0,
  revenueAmount: (r) => marketplaceRevenueAmount(r),
  taxAmount: (r) => Number(r.taxAmount) || 0,
  netIncome: (r) => Number(r.netIncome) || 0,
};

export function ProductEconomicsTable({ loading, emptyMessage, items }) {
  const { sort, toggleSort } = useTableSort('soldAmount', 'desc');
  const sorted = useMemo(() => sortRows(items, sort, PRODUCT_SORT_GETTERS), [items, sort]);

  return (
    <div className="sales-analytics__table-wrap">
      <table className="sales-analytics__table">
        <thead>
          <tr>
            <SortableTh sortKey="productName" sort={sort} onSort={toggleSort}>
              Товар
            </SortableTh>
            <SortableTh sortKey="erpSku" sort={sort} onSort={toggleSort}>
              Артикул
            </SortableTh>
            <SortableTh sortKey="soldQty" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Продано
            </SortableTh>
            <SortableTh sortKey="soldAmount" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Сумма продаж
            </SortableTh>
            <SortableTh sortKey="commissionAmount" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Комиссия
            </SortableTh>
            <SortableTh sortKey="logisticsAmount" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Логистика
            </SortableTh>
            <SortableTh sortKey="storageAmount" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Хранение
            </SortableTh>
            <SortableTh sortKey="otherDeductions" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Прочее
            </SortableTh>
            <SortableTh sortKey="payoutAmount" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              К выплате
            </SortableTh>
            <SortableTh sortKey="costAmount" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Себестоимость
            </SortableTh>
            <SortableTh
              sortKey="additionalExpensesAmount"
              sort={sort}
              onSort={toggleSort}
              className="sales-analytics__num"
              title="qty × дополнительные расходы из карточки товара"
            >
              Доп. расходы
            </SortableTh>
            <SortableTh
              sortKey="revenueAmount"
              sort={sort}
              onSort={toggleSort}
              className="sales-analytics__num"
              title="К выплате − себестоимость − доп. расходы. У WB ещё − логистика."
            >
              Выручка
            </SortableTh>
            <SortableTh
              sortKey="taxAmount"
              sort={sort}
              onSort={toggleSort}
              className="sales-analytics__num"
              title="По схеме организации. УСН 15% / ОСН — только с прибыли; при убытке = 0"
            >
              Налоги
            </SortableTh>
            <SortableTh
              sortKey="netIncome"
              sort={sort}
              onSort={toggleSort}
              className="sales-analytics__num"
              title="Пришло от МП − себестоимость − доп. расходы − налоги"
            >
              Чистый доход
            </SortableTh>
          </tr>
        </thead>
        <tbody>
          {!loading && sorted.length === 0 && (
            <tr>
              <td colSpan={14} className="sales-analytics__empty">
                {emptyMessage}
              </td>
            </tr>
          )}
          {sorted.map((row) => (
            <tr key={`${row.productId || 'x'}-${row.sku}`}>
              <td>{row.productName || '—'}</td>
              <td>
                {row.erpSku ? (
                  <span title={row.productId ? `ID ${row.productId}` : undefined}>{row.erpSku}</span>
                ) : (
                  <span className="fbo-sales-analytics__unlinked">—</span>
                )}
              </td>
              <td className="sales-analytics__num">{formatQty(row.soldQty)}</td>
              <td className="sales-analytics__num">{formatRub(row.soldAmount)}</td>
              <td className="sales-analytics__num">{formatRub(row.commissionAmount)}</td>
              <td className="sales-analytics__num">{formatRub(row.logisticsAmount)}</td>
              <td className="sales-analytics__num">{formatRub(row.storageAmount)}</td>
              <td className="sales-analytics__num">{formatRub(otherDeductions(row))}</td>
              <td className="sales-analytics__num">{formatRub(row.payoutAmount)}</td>
              <td className="sales-analytics__num">{formatRub(row.costAmount)}</td>
              <td className="sales-analytics__num">{formatRub(row.additionalExpensesAmount)}</td>
              <td className="sales-analytics__num">{formatRub(marketplaceRevenueAmount(row))}</td>
              <AmountCell value={row.taxAmount} format={formatRub} tooltip={row.taxTooltip} />
              <td className="sales-analytics__num">{formatRub(row.netIncome)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
