/**
 * Карточка заказа на сборке FBS: SKU комплекта и комплектующих — каждая своей строкой,
 * с резервом этого заказа и доступным остатком.
 */

import React from 'react';
import {
  formatAssemblyWarehouseStock,
  mergeComponentStock,
  orderReserveAvailableLabel,
  orderHintAvailable,
} from '../../utils/assemblyWarehouseStock';
import { marketplaceOrderIdForApi } from '../../utils/orderListGroupKey';

function HintLine({ kind, article, quantity, stockLabel }) {
  return (
    <div className="assembly-hint-line">
      <span className="assembly-hint-line__left">
        {kind ? (
          <span
            className={`assembly-next__kind${
              kind === 'Комплект' ? ' assembly-next__kind--kit' : ' assembly-next__kind--product'
            }`}
          >
            {kind}
          </span>
        ) : null}
        <span className="assembly-next__sku">
          {article}
          {quantity > 0 ? <span className="assembly-next__qty">×{quantity}</span> : null}
        </span>
      </span>
      {stockLabel ? (
        <span className="assembly-next__comp-stock muted-hint">{stockLabel}</span>
      ) : null}
    </div>
  );
}

export function AssemblyHintCard({
  label,
  recommendation,
  hintStock,
  stockLoading = false,
  overlay,
  warehouseNameById,
  mpDisplay,
  emptyText,
}) {
  if (!recommendation) {
    return (
      <div className="assembly-hint-card">
        <div className="assembly-next__label">{label}</div>
        <div className="assembly-next__skus assembly-next__skus--done">{emptyText}</div>
      </div>
    );
  }

  const overlaySafe = overlay || { kitScanned: 0, byPid: new Map() };
  const merged = mergeComponentStock(recommendation.components, hintStock?.components);
  const packing = String(recommendation.packingDisplayValue ?? '').trim();
  const whName = recommendation.warehouseId
    ? warehouseNameById?.get(recommendation.warehouseId) || `#${recommendation.warehouseId}`
    : '';
  const mp = mpDisplay?.(recommendation.order.marketplace);

  return (
    <div className="assembly-hint-card">
      <div className="assembly-next__label">{label}</div>
      <div className="assembly-next__name">{recommendation.productName}</div>
      <div className="assembly-hint-lines">
        <HintLine
          kind={recommendation.isKit ? 'Комплект' : 'Товар'}
          article={recommendation.article}
          quantity={recommendation.quantity}
          stockLabel={
            hintStock
              ? orderReserveAvailableLabel({
                  reservedForOrder: hintStock.reservedForOrder,
                  available: orderHintAvailable(hintStock, { isKit: recommendation.isKit }),
                  scanned: overlaySafe.kitScanned,
                })
              : null
          }
        />
        {recommendation.isKit && merged.length > 0 ? (
          <>
            <div className="assembly-hint-line assembly-hint-line--section">Комплектующие</div>
            {merged.map((c, i) => {
              const pid = Number(c.productId ?? c.product_id ?? c.stock?.productId);
              const scanned =
                Number.isFinite(pid) && pid > 0 ? overlaySafe.byPid.get(pid) || 0 : 0;
              return (
                <HintLine
                  key={`${c.article}-${i}`}
                  article={c.article}
                  quantity={c.quantity}
                  stockLabel={
                    c.stock
                      ? orderReserveAvailableLabel({
                          reservedForOrder: c.stock.reservedForOrder,
                          available: c.stock.available,
                          scanned,
                        })
                      : null
                  }
                />
              );
            })}
          </>
        ) : null}
      </div>
      <div className="assembly-next__packing">
        <span className="assembly-next__packing-label">Упаковка:</span>{' '}
        {packing || '—'}
      </div>
      <div className="assembly-next__stock muted-hint">
        {recommendation.warehouseId ? (
          stockLoading ? (
            <>На складе {whName}: …</>
          ) : (
            formatAssemblyWarehouseStock(hintStock, {
              warehouseName: whName,
              isKit: recommendation.isKit,
            })
          )
        ) : (
          'Склад заказа не указан — остаток не показан'
        )}
      </div>
      <div className="assembly-next__order muted-hint">
        Заказ{' '}
        {marketplaceOrderIdForApi(recommendation.rows, recommendation.order.marketplace) ||
          recommendation.order.orderId}
        {mp ? ` · ${mp.name}` : ''}
      </div>
    </div>
  );
}
