/**
 * Карточка заказа на сборке FBS в две колонки: слева SKU комплекта и комплектующих
 * с остатком «на полке» (и сколько осталось отсканировать), справа маркетплейс, номер заказа,
 * стикер и упаковка.
 */

import React from 'react';
import {
  mergeComponentStock,
  onShelfLabel,
  stockOnShelf,
} from '../../utils/assemblyWarehouseStock';
import { marketplaceOrderIdForApi } from '../../utils/orderListGroupKey';
import { OrderStickerDisplay } from '../../components/orders/OrderStickerDisplay';

function KindBadge({ kind }) {
  return (
    <span
      className={`assembly-next__kind${
        kind === 'Комплект' ? ' assembly-next__kind--kit' : ' assembly-next__kind--product'
      }`}
    >
      {kind}
    </span>
  );
}

function HintLine({ article, quantity, stockLabel, remaining = null }) {
  return (
    <div className="assembly-hint-line">
      <span className="assembly-hint-line__left">
        <span className="assembly-next__sku">
          {article}
          {quantity > 0 ? <span className="assembly-next__qty">×{quantity}</span> : null}
        </span>
        {remaining != null ? (
          <span
            className={`assembly-hint-line__remaining${
              remaining > 0 ? '' : ' assembly-hint-line__remaining--done'
            }`}
          >
            {remaining > 0 ? `осталось ${remaining}` : 'готово'}
          </span>
        ) : null}
      </span>
      {stockLabel ? (
        <span className="assembly-next__comp-stock muted-hint">{stockLabel}</span>
      ) : null}
    </div>
  );
}

function remainingFor(map, productId) {
  if (!(map instanceof Map)) return null;
  const pid = Number(productId);
  if (!Number.isFinite(pid) || !map.has(pid)) return null;
  return map.get(pid);
}

export function AssemblyHintCard({
  label,
  recommendation,
  hintStock,
  overlay,
  mpDisplay,
  emptyText,
  headerScan = null,
  scan = null,
  remainingByPid = null,
  showPacking = false,
  stickerAction = null,
  children = null,
}) {
  const header = (
    <div className="assembly-next__label">
      <span>{label}</span>
      {headerScan ? <div className="assembly-next__header-scan">{headerScan}</div> : null}
    </div>
  );

  if (!recommendation) {
    return (
      <div className="assembly-hint-card assembly-hint-card--empty">
        {header}
        <div className="assembly-next__skus assembly-next__skus--done">{emptyText}</div>
        {scan}
        {children}
      </div>
    );
  }

  const overlaySafe = overlay || { kitScanned: 0, byPid: new Map() };
  const merged = mergeComponentStock(recommendation.components, hintStock?.components);
  const packing = String(recommendation.packingDisplayValue ?? '').trim();
  const mp = mpDisplay?.(recommendation.order.marketplace);
  const orderNo =
    marketplaceOrderIdForApi(recommendation.rows, recommendation.order.marketplace) ||
    recommendation.order.orderId;

  return (
    <div className="assembly-hint-card">
      {header}
      <div className="assembly-next__name-row">
        <span className="assembly-next__name" title={recommendation.productName}>
          {recommendation.productName}
        </span>
        <KindBadge kind={recommendation.isKit ? 'Комплект' : 'Товар'} />
      </div>
      <div className="assembly-hint-cols">
        <div className="assembly-hint-cols__goods">
          <div className="assembly-hint-lines">
            <HintLine
              article={recommendation.article}
              quantity={recommendation.quantity}
              remaining={remainingFor(remainingByPid, recommendation.productId)}
              stockLabel={
                hintStock
                  ? onShelfLabel({
                      onShelf: stockOnShelf(hintStock),
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
                      remaining={remainingFor(remainingByPid, pid)}
                      stockLabel={
                        c.stock
                          ? onShelfLabel({
                              onShelf: stockOnShelf(c.stock),
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
        </div>
        <dl className="assembly-hint-cols__order">
          <div className="assembly-hint-meta">
            <dt>Маркетплейс</dt>
            <dd>
              {mp ? (
                <span className={`mp-badge ${mp.badgeClass}`} title={mp.name} aria-label={mp.name}>
                  {mp.shortLabel}
                </span>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div className="assembly-hint-meta">
            <dt>Заказ</dt>
            <dd>{orderNo ? `№ ${orderNo}` : '—'}</dd>
          </div>
          <div className="assembly-hint-meta">
            <dt>Стикер</dt>
            <dd className="assembly-hint-meta__sticker">
              <OrderStickerDisplay order={recommendation.order} groupOrders={recommendation.rows} />
              {stickerAction}
            </dd>
          </div>
          {showPacking ? (
            <div className="assembly-hint-meta">
              <dt>Упаковка</dt>
              <dd>{packing || '—'}</dd>
            </div>
          ) : null}
        </dl>
      </div>
      {scan}
      {children}
    </div>
  );
}
