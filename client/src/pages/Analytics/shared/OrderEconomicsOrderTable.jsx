import React, { useMemo } from 'react';
import { AmountCell, otherDeductionsTotal } from './AmountCell';
import { formatQty, formatRub, orderEconomicsFromRow } from './orderEconomics';
import { SortableTh, sortRows, useTableSort } from './tableSort';

function costsParts(row) {
  return [
    { label: 'Комиссия', value: Number(row.commissionAmount) || 0 },
    { label: 'Логистика', value: Number(row.logisticsAmount) || 0 },
    { label: 'Хранение', value: Number(row.storageAmount) || 0 },
    { label: 'Штрафы', value: Number(row.penaltyAmount) || 0 },
    { label: 'Эквайринг', value: Number(row.acquiringAmount) || 0 },
    { label: 'Прочее', value: Number(row.otherDeductions) || 0 },
  ];
}

function CostsCell({ row }) {
  const eco = orderEconomicsFromRow(row);
  const parts = costsParts(row).filter((p) => p.value !== 0);
  const lines = parts.length ? parts : [{ label: 'Нет статей', value: 0 }];
  return (
    <td className="sales-analytics__num sales-analytics__num--hint sales-analytics__tip sales-analytics__col-cost-total">
      {formatRub(eco.costsTotal)}
      <span className="sales-analytics__tip-box" role="tooltip">
        <b>Итого затрат {formatRub(eco.costsTotal)}</b>
        {lines.map((p) => (
          <span key={p.label} className="sales-analytics__tip-row">
            <span>{p.label}</span>
            <span>{formatRub(p.value)}</span>
          </span>
        ))}
      </span>
    </td>
  );
}

function marketplaceLabel(mp) {
  const v = String(mp || '').toLowerCase();
  if (v === 'ozon') return 'Ozon';
  if (v === 'wb' || v === 'wildberries') return 'Wildberries';
  if (v === 'ym' || v === 'yandex' || v === 'yandexmarket') return 'Яндекс';
  return mp || '—';
}

const ORDER_SORT_GETTERS = {
  operationDate: (r) => r.operationDate || '',
  marketplace: (r) => marketplaceLabel(r.marketplace),
  orderId: (r) => r.orderId || (r.postingNumber && r.postingNumber !== '0' ? r.postingNumber : '') || '',
  productName: (r) => r.productName || '',
  quantity: (r) => Number(r.quantity) || 0,
  saleAmount: (r) => orderEconomicsFromRow(r).saleAmount,
  costsTotal: (r) => orderEconomicsFromRow(r).costsTotal,
  commissionAmount: (r) => Number(r.commissionAmount) || 0,
  logisticsAmount: (r) => Number(r.logisticsAmount) || 0,
  storageAmount: (r) => Number(r.storageAmount) || 0,
  otherDeductions: (r) => otherDeductionsTotal(r),
  receivedAmount: (r) => orderEconomicsFromRow(r).receivedAmount,
  costAmount: (r) => Number(r.costAmount) || 0,
  additionalExpensesAmount: (r) => orderEconomicsFromRow(r).additionalExpensesAmount,
  revenueAmount: (r) => orderEconomicsFromRow(r).revenueAmount,
  taxAmount: (r) => Number(r.taxAmount) || 0,
  netIncome: (r) => Number(r.netIncome) || 0,
};

/**
 * Таблица «По заказам»: цена продажи, затраты, сколько пришло — затем разбивка.
 */
export function OrderEconomicsOrderTable({ loading, emptyMessage, orders }) {
  const { sort, toggleSort } = useTableSort('operationDate', 'desc');
  const sorted = useMemo(() => sortRows(orders, sort, ORDER_SORT_GETTERS), [orders, sort]);

  return (
    <div className="sales-analytics__table-wrap">
      <table className="sales-analytics__table">
        <thead>
          <tr>
            <SortableTh sortKey="operationDate" sort={sort} onSort={toggleSort} className="sales-analytics__date">
              Дата
            </SortableTh>
            <SortableTh sortKey="marketplace" sort={sort} onSort={toggleSort}>
              МП
            </SortableTh>
            <SortableTh
              sortKey="orderId"
              sort={sort}
              onSort={toggleSort}
              className="sales-analytics__order"
              title="Заказ / отправление"
            >
              Заказ
            </SortableTh>
            <SortableTh sortKey="productName" sort={sort} onSort={toggleSort}>
              Товар
            </SortableTh>
            <SortableTh sortKey="quantity" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Кол-во
            </SortableTh>
            <SortableTh
              sortKey="saleAmount"
              sort={sort}
              onSort={toggleSort}
              className="sales-analytics__num"
              title="У WB — цена до скидки маркетплейса (от неё считается комиссия). Оплата покупателя после скидки — в подсказке к сумме."
            >
              Цена продажи
            </SortableTh>
            <SortableTh
              sortKey="costsTotal"
              sort={sort}
              onSort={toggleSort}
              className="sales-analytics__num sales-analytics__num--hint sales-analytics__col-cost-total"
              title="Удержания МП (комиссия, логистика, хранение, штрафы, эквайринг, прочее). Себестоимость и доп. расходы не входят. Наведите на сумму — разбивка."
            >
              Итого затрат
            </SortableTh>
            <SortableTh
              sortKey="commissionAmount"
              sort={sort}
              onSort={toggleSort}
              className="sales-analytics__num sales-analytics__col-cost-part"
            >
              Комиссия
            </SortableTh>
            <SortableTh
              sortKey="logisticsAmount"
              sort={sort}
              onSort={toggleSort}
              className="sales-analytics__num sales-analytics__col-cost-part"
            >
              Логистика
            </SortableTh>
            <SortableTh
              sortKey="storageAmount"
              sort={sort}
              onSort={toggleSort}
              className="sales-analytics__num sales-analytics__col-cost-part"
            >
              Хранение
            </SortableTh>
            <SortableTh
              sortKey="otherDeductions"
              sort={sort}
              onSort={toggleSort}
              className="sales-analytics__num sales-analytics__col-cost-part"
            >
              Прочее
            </SortableTh>
            <SortableTh
              sortKey="receivedAmount"
              sort={sort}
              onSort={toggleSort}
              className="sales-analytics__num"
              title="Сумма к перечислению в финансовом отчёте МП"
            >
              Пришло от МП
            </SortableTh>
            <SortableTh
              sortKey="costAmount"
              sort={sort}
              onSort={toggleSort}
              className="sales-analytics__num"
              title="qty × себестоимость товара в ERP"
            >
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
              title="Пришло от МП − себестоимость − доп. расходы. У WB ещё − логистика (в выплате её нет)."
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
              title="Выручка − налоги. Удержания МП в выплате, кроме логистики WB (она в выручке)."
            >
              Чистый доход
            </SortableTh>
          </tr>
        </thead>
        <tbody>
          {!loading && sorted.length === 0 && (
            <tr>
              <td colSpan={17} className="sales-analytics__empty">
                {emptyMessage}
              </td>
            </tr>
          )}
          {sorted.map((row, idx) => {
            const eco = orderEconomicsFromRow(row);
            return (
              <tr key={`${row.orderId || row.postingNumber || idx}`}>
                <td className="sales-analytics__date">{row.operationDate || '—'}</td>
                <td>{marketplaceLabel(row.marketplace)}</td>
                <td
                  className="sales-analytics__order"
                  title={row.lineCount > 1 ? `Операций в отчёте: ${row.lineCount}` : undefined}
                >
                  {row.orderId ||
                    (row.postingNumber && row.postingNumber !== '0' ? row.postingNumber : null) ||
                    '—'}
                </td>
                <td>
                  {row.productName || '—'}
                  {row.erpSku ? (
                    <span className="fbo-sales-analytics__erp-sku"> · {row.erpSku}</span>
                  ) : null}
                </td>
                <td className="sales-analytics__num">{formatQty(row.quantity)}</td>
                <AmountCell value={eco.saleAmount} format={formatRub} tooltip={row.amountTooltips?.retail} />
                <CostsCell row={row} />
                <AmountCell
                  className="sales-analytics__num sales-analytics__col-cost-part"
                  value={row.commissionAmount}
                  format={formatRub}
                  tooltip={row.amountTooltips?.commission}
                />
                <AmountCell
                  className="sales-analytics__num sales-analytics__col-cost-part"
                  value={row.logisticsAmount}
                  format={formatRub}
                  tooltip={row.amountTooltips?.logistics}
                />
                <AmountCell
                  className="sales-analytics__num sales-analytics__col-cost-part"
                  value={row.storageAmount}
                  format={formatRub}
                  tooltip={row.amountTooltips?.storage}
                />
                <AmountCell
                  className="sales-analytics__num sales-analytics__col-cost-part"
                  value={otherDeductionsTotal(row)}
                  format={formatRub}
                  tooltip={row.amountTooltips?.other}
                />
                <td className="sales-analytics__num">{formatRub(eco.receivedAmount)}</td>
                <td className="sales-analytics__num">{formatRub(row.costAmount)}</td>
                <td className="sales-analytics__num">{formatRub(eco.additionalExpensesAmount)}</td>
                <td className="sales-analytics__num">{formatRub(eco.revenueAmount)}</td>
                <AmountCell value={row.taxAmount} format={formatRub} tooltip={row.taxTooltip} />
                <td className="sales-analytics__num">{formatRub(row.netIncome)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
