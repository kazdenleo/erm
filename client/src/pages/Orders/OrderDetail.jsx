/**
 * Order Detail Page
 * Карточка заказа: Ozon (v3/posting/fbs/get), Wildberries (api/v3/orders/new), Яндекс.Маркет (GET v2/campaigns/.../orders/...)
 */

import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useProductCardModal } from '../../context/ProductCardModalContext.jsx';
import { ordersApi } from '../../services/orders.api';
import { Button } from '../../components/common/Button/Button';
import { getOrderStatusLabel } from '../../constants/orderStatuses';
import { marketplaceOrderIdForApi } from '../../utils/orderListGroupKey';
import './OrderDetail.css';

function orderReserveLineKey(line) {
  const rowId = line.orderRowDbId ?? line.order_row_db_id ?? '';
  return `${rowId || (line.orderLineId ?? '')}-${line.productId}-${line.lineKind}`;
}

function lineReserveBounds(line) {
  const reserved = Math.max(0, Number(line.reservedQty) || 0);
  const need = Math.max(0, Number(line.needQty) || 0);
  const remaining = Math.max(0, need - reserved);
  const available =
    line.availableQty != null && !Number.isNaN(Number(line.availableQty))
      ? Math.max(0, Number(line.availableQty))
      : remaining;
  const maxReserve = Math.min(remaining, available);
  return { reserved, need, remaining, available, maxReserve };
}

function clampLineQty(raw, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Резерв на складе: весь заказ и отдельные товары / комплектующие (с частичным количеством) */
export function OrderReservePanel({ marketplace, orderId, reserve: reserveProp, onChanged }) {
  const [reserve, setReserve] = useState(reserveProp ?? null);
  const [loading, setLoading] = useState(false);
  const [lineLoadingKey, setLineLoadingKey] = useState(null);
  const [lineQty, setLineQty] = useState({});
  const [feedback, setFeedback] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (reserveProp !== undefined) {
      setReserve(reserveProp ?? null);
    }
  }, [reserveProp]);

  useEffect(() => {
    if (!marketplace || !orderId) return;
    const propLines = Array.isArray(reserveProp?.lines) ? reserveProp.lines : [];
    if (propLines.length > 0) return;
    let cancelled = false;
    ordersApi
      .getOrderReserve(marketplace, orderId)
      .then((r) => {
        if (!cancelled) setReserve(r ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [marketplace, orderId, reserveProp]);

  const detailLines = Array.isArray(reserve?.lines)
    ? reserve.lines.filter((l) => Math.max(0, Number(l.needQty) || 0) > 0)
    : [];

  useEffect(() => {
    const next = {};
    for (const line of detailLines) {
      const key = orderReserveLineKey(line);
      const { reserved, maxReserve } = lineReserveBounds(line);
      const prev = lineQty[key];
      if (reserved > 0) {
        const max = reserved;
        next[key] = prev != null ? clampLineQty(prev, 1, max) : 1;
      } else if (maxReserve > 0) {
        const max = maxReserve;
        next[key] = prev != null ? clampLineQty(prev, 1, max) : Math.min(1, max);
      }
    }
    setLineQty(next);
  }, [reserve, detailLines.length]);

  const applyResult = (result) => {
    setReserve(result);
    setFeedback(result?.message || null);
    onChanged?.(result);
  };

  const handleToggleAll = async () => {
    if (!marketplace || !orderId || loading) return;
    setLoading(true);
    setError(null);
    setFeedback(null);
    try {
      const result = await ordersApi.setOrderReserve(marketplace, orderId, {
        action: hasReserve ? 'unreserve' : 'reserve'
      });
      applyResult(result);
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Не удалось изменить резерв');
    } finally {
      setLoading(false);
    }
  };

  const handleLineAction = async (line, action, qtyOverride = null) => {
    const pid = line?.productId;
    if (!marketplace || !orderId || !pid || lineLoadingKey) return;
    const key = orderReserveLineKey(line);
    const { reserved, maxReserve } = lineReserveBounds(line);
    const act = String(action || '').toLowerCase();
    const isUnreserve = act === 'unreserve';
    const max = isUnreserve ? reserved : maxReserve;
    if (max <= 0) return;
    const qty =
      qtyOverride != null
        ? clampLineQty(qtyOverride, 1, max)
        : clampLineQty(lineQty[key], 1, max);

    setLineLoadingKey(key);
    setError(null);
    setFeedback(null);
    try {
      const result = await ordersApi.setOrderReserve(marketplace, orderId, {
        action: isUnreserve ? 'unreserve' : 'reserve',
        productId: pid,
        quantity: qty
      });
      applyResult(result);
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Не удалось изменить резерв по позиции');
    } finally {
      setLineLoadingKey(null);
    }
  };

  if (!marketplace || !orderId) return null;

  const reservedQty = Number(reserve?.reservedQty ?? 0) || 0;
  const needQty = Number(reserve?.needQty ?? 0) || 0;
  const hasReserve = reserve?.hasReserve === true || reservedQty > 0;
  const label = hasReserve ? 'Снять весь резерв' : 'Поставить резерв на заказ';
  const variant = hasReserve ? 'secondary' : 'primary';

  return (
    <section className="order-detail-section order-reserve-panel" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: '1 1 200px' }}>
          <h3 style={{ margin: '0 0 4px' }}>Резерв на складе</h3>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted, #666)' }}>
            {needQty > 0
              ? `Зарезервировано по заказу: ${reservedQty} из ${needQty}`
              : reserve == null
                ? 'Загрузка…'
                : 'Нет данных о количестве'}
          </p>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--muted, #888)' }}>
            По каждой позиции укажите количество и нажмите «Снять» или «В резерв» (не обязательно всё сразу).
          </p>
        </div>
        <Button variant={variant} size="small" onClick={handleToggleAll} disabled={loading}>
          {loading ? '…' : label}
        </Button>
      </div>
      {detailLines.length > 0 && (
        <ul style={{ margin: '12px 0 0', padding: 0, listStyle: 'none', fontSize: 13 }}>
          {detailLines.map((line) => {
            const pid = line.productId;
            const canReserve = pid != null && Number(pid) > 0;
            const key = orderReserveLineKey(line);
            const { reserved: r, need: n, remaining, available, maxReserve } = lineReserveBounds(line);
            const lineHas = r > 0;
            const maxQty = lineHas ? r : maxReserve;
            const title =
              line.label ||
              line.productName ||
              line.product_name ||
              (line.offerId || line.offer_id
                ? `Арт. ${line.offerId || line.offer_id}`
                : null) ||
              (line.lineKind === 'component'
                ? `Комплектующая${pid ? ` #${pid}` : ''}`
                : pid
                  ? `Товар #${pid}`
                  : 'Позиция без привязки к товару');
            const qtyVal = lineQty[key] ?? (lineHas ? 1 : Math.min(1, maxQty || 1));
            return (
              <li
                key={key}
                className="order-reserve-line"
              >
                <span className="order-reserve-line__title">
                  {title}: <strong>{r}</strong> из {n}
                  {!lineHas && remaining > 0 ? (
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                      {' '}
                      (доступно к резерву: {available})
                    </span>
                  ) : null}
                  {!canReserve ? (
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}> — привяжите товар в каталоге</span>
                  ) : null}
                </span>
                <div className="order-reserve-line__actions">
                  <label className="order-reserve-line__qty">
                    <span className="visually-hidden">Количество</span>
                    <input
                      type="number"
                      className="form-control form-control-sm"
                      min={1}
                      max={maxQty > 0 ? maxQty : 1}
                      value={maxQty > 0 ? qtyVal : 0}
                      disabled={loading || lineLoadingKey === key || maxQty <= 0 || !canReserve}
                      onChange={(e) =>
                        setLineQty((prev) => ({
                          ...prev,
                          [key]: clampLineQty(e.target.value, 1, Math.max(1, maxQty))
                        }))
                      }
                    />
                    <span className="order-reserve-line__qty-suffix">шт.</span>
                  </label>
                  <Button
                    variant={lineHas ? 'secondary' : 'primary'}
                    size="small"
                    disabled={loading || lineLoadingKey === key || maxQty <= 0 || !canReserve}
                    onClick={() =>
                      handleLineAction(line, lineHas ? 'unreserve' : 'reserve')
                    }
                  >
                    {lineLoadingKey === key ? '…' : lineHas ? 'Снять' : 'В резерв'}
                  </Button>
                  {maxQty > 1 ? (
                    <button
                      type="button"
                      className="order-reserve-line__max-btn"
                      disabled={loading || lineLoadingKey === key}
                      onClick={() => {
                        setLineQty((prev) => ({ ...prev, [key]: maxQty }));
                        handleLineAction(line, lineHas ? 'unreserve' : 'reserve', maxQty);
                      }}
                    >
                      {lineHas ? 'Снять всё' : 'Макс.'}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {feedback && (
        <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--success, #2e7d32)' }}>{feedback}</p>
      )}
      {error && (
        <p className="error" style={{ margin: '8px 0 0', fontSize: 13 }}>{error}</p>
      )}
    </section>
  );
}

const marketplaceNames = {
  ozon: 'Ozon',
  wildberries: 'Wildberries',
  wb: 'Wildberries',
  yandex: 'Яндекс.Маркет'
};

function formatAssemblyWho(assembly) {
  if (!assembly) return '—';
  const name = (assembly.assembledByFullName || '').trim();
  const email = (assembly.assembledByEmail || '').trim();
  if (name && email) return `${name} (${email})`;
  return name || email || '—';
}

/** Ссылка в каталог ERM по product_id из локальной строки заказа */
function ProductTitleLink({ productId, children }) {
  const { openProductCardFromClick } = useProductCardModal();
  const raw = productId != null && productId !== '' ? Number(productId) : NaN;
  if (!Number.isInteger(raw) || raw < 1) return <>{children}</>;
  return (
    <button
      type="button"
      onClick={(e) => openProductCardFromClick(raw, e)}
      className="order-detail-product-link"
      title="Открыть карточку товара"
      style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer' }}
    >
      {children}
    </button>
  );
}

/** Артикул строки заказа: SKU каталога, иначе offer_id / id на МП */
function orderArticleFromLine(o) {
  if (!o) return null;
  const v =
    o.productSku ??
    o.product_sku ??
    o.offerId ??
    o.offer_id ??
    (o.sku != null && o.sku !== '' ? String(o.sku) : null);
  const s = v != null ? String(v).trim() : '';
  return s !== '' ? s : null;
}

function erpProductIdForOzonLine(localLines, p) {
  if (!localLines?.length || !p) return null;
  const offer = String(p.offer_id ?? '').trim();
  const sku = String(p.sku ?? '').trim();
  if (offer) {
    const row = localLines.find((l) => String(l.offerId ?? '').trim() === offer);
    if (row?.productId != null) return row.productId;
  }
  if (sku) {
    const row = localLines.find((l) => String(l.offerId ?? '').trim() === sku);
    if (row?.productId != null) return row.productId;
    const rowMs = localLines.find((l) => String(l.marketplaceSku ?? '').trim() === sku);
    if (rowMs?.productId != null) return rowMs.productId;
  }
  if (localLines.length === 1 && localLines[0].productId != null) return localLines[0].productId;
  return null;
}

function erpProductIdForWb(localLines, detail) {
  if (!localLines?.length || !detail) return null;
  const candidates = [];
  const push = (v) => {
    const s = String(v ?? '').trim();
    if (s) candidates.push(s);
  };
  push(detail.article);
  push(detail.nmId);
  if (Array.isArray(detail.skus)) detail.skus.forEach((s) => push(s));

  for (const key of candidates) {
    const row = localLines.find((l) => String(l.offerId ?? '').trim() === key);
    if (row?.productId != null) return row.productId;
    const rowMs = localLines.find((l) => String(l.marketplaceSku ?? '').trim() === key);
    if (rowMs?.productId != null) return rowMs.productId;
  }
  if (localLines.length === 1 && localLines[0].productId != null) return localLines[0].productId;
  return null;
}

function erpProductIdForYandexLine(localLines, it) {
  if (!localLines?.length || !it) return null;
  const oid = String(it.offerId ?? '').trim();
  if (oid) {
    const row = localLines.find((l) => String(l.offerId ?? '').trim() === oid);
    if (row?.productId != null) return row.productId;
  }
  const shop = String(it.shopSku ?? '').trim();
  if (shop) {
    const row = localLines.find((l) => String(l.offerId ?? '').trim() === shop);
    if (row?.productId != null) return row.productId;
  }
  if (localLines.length === 1 && localLines[0].productId != null) return localLines[0].productId;
  return null;
}

export function OrderDetail() {
  const { marketplace, orderId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const result = await ordersApi.getOrderDetail(marketplace, orderId);
        if (!cancelled) setData(result);
      } catch (e) {
        if (!cancelled) {
          setError(e.response?.data?.message || e.message || 'Ошибка загрузки заказа');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [marketplace, orderId]);

  if (loading) {
    return (
      <div className="card order-detail">
        <div className="loading">Загрузка заказа...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card order-detail">
        <div className="error" style={{ marginBottom: 16 }}>{error}</div>
        <Button variant="secondary" onClick={() => navigate('/orders')}>← К списку заказов</Button>
      </div>
    );
  }

  const mpFromUrl = String(marketplace || '').toLowerCase();
  const mpFromData = String(data?.marketplace || '').toLowerCase();
  const mpKey =
    mpFromData ||
    (mpFromUrl === 'wb' ? 'wildberries' : mpFromUrl === 'ym' || mpFromUrl === 'yandexmarket' ? 'yandex' : mpFromUrl);
  const mpName = marketplaceNames[mpKey] || marketplaceNames[marketplace] || marketplace;
  const detail = data?.detail;
  const localLines = data?.localLines;

  return (
    <div className="card order-detail">
      <div className="order-detail-header">
        <Button variant="secondary" size="small" onClick={() => navigate('/orders')}>
          ← Заказы
        </Button>
        <h1 className="title" style={{ margin: '12px 0 0' }}>
          Заказ {orderId}
          <span className="order-detail-marketplace"> ({mpName})</span>
        </h1>
      </div>

      <OrderReservePanel
        marketplace={marketplace}
        orderId={orderId}
        reserve={data?.reserve}
        onChanged={(r) => setData((d) => (d ? { ...d, reserve: r } : d))}
      />

      {(data?.assembly?.assembledAt ||
        data?.assembly?.assembledByEmail ||
        data?.assembly?.assembledByFullName ||
        data?.assembly?.assemblyStickerNumber) && (
        <section className="order-detail-section" style={{ marginTop: 16 }}>
          <h3>Сборка в системе</h3>
          <dl className="detail-dl">
            <dt>Собран</dt>
            <dd>
              {data.assembly.assembledAt
                ? new Date(data.assembly.assembledAt).toLocaleString('ru-RU')
                : '—'}
            </dd>
            <dt>Собрал</dt>
            <dd>{formatAssemblyWho(data.assembly)}</dd>
            <dt>Номер стикера</dt>
            <dd>{data.assembly.assemblyStickerNumber || '—'}</dd>
          </dl>
        </section>
      )}

      {mpKey === 'ozon' && detail && (
        <OzonDetail detail={detail} localLines={localLines} />
      )}
      {(mpKey === 'wildberries' || mpKey === 'wb') && detail && (
        <WildberriesDetail detail={detail} localLines={localLines} />
      )}
      {(mpKey === 'yandex' || mpKey === 'ym' || mpKey === 'yandexmarket') && detail && (
        <>
          {data.fromLocal && (
            <p className="order-detail-local-hint" style={{ marginBottom: 12, fontSize: 13, color: 'var(--muted)' }}>
              Заказ не найден в API маркетплейса. Показаны сохранённые в системе данные.
            </p>
          )}
          <YandexDetail detail={detail} localLines={localLines} />
        </>
      )}
    </div>
  );
}

/** Все позиции заказа из локальной БД (для многотоварных заказов YM/Ozon/WB). */
function LocalOrderLinesSection({ localLines }) {
  const lines = Array.isArray(localLines) ? localLines : [];
  if (!lines.length) return null;
  return (
    <section className="order-detail-section">
      <h3>Товары в системе{lines.length > 1 ? ` (${lines.length})` : ''}</h3>
      <ul className="order-detail-products">
        {lines.map((line, i) => {
          const pid = line.productId ?? line.product_id;
          const name = line.productName || line.product_name || line.offerId || '—';
          const art = line.offerId ?? line.marketplaceSku ?? '—';
          return (
            <li key={line.orderLineId ?? line.order_line_id ?? i}>
              <ProductTitleLink productId={pid}>
                <strong>{name}</strong>
              </ProductTitleLink>
              <br />
              Артикул: {art}
              {line.quantity != null ? `, кол-во: ${line.quantity}` : ''}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Контент деталей заказа по данным API (для использования в модалке на странице заказов) */
export function OrderDetailContent({ data, orderId: orderIdProp, onReserveChange }) {
  if (!data) return null;
  const detail = data.detail;
  const localLines = data.localLines;
  const assembly = data.assembly;
  const orderIdRaw = orderIdProp ?? data.orderId ?? null;
  const orderId = marketplaceOrderIdForApi(orderIdRaw, data.marketplace);
  const mp = String(data.marketplace || '').toLowerCase();
  const mpNorm =
    mp === 'wb'
      ? 'wildberries'
      : mp === 'ym' || mp === 'yandexmarket'
        ? 'yandex'
        : mp;
  const reserveBlock =
    orderId && data.marketplace ? (
      <OrderReservePanel
        marketplace={data.marketplace}
        orderId={orderId}
        reserve={data.reserve}
        onChanged={onReserveChange}
      />
    ) : null;
  const assemblyBlock =
    assembly &&
    (assembly.assembledAt ||
      assembly.assembledByEmail ||
      assembly.assembledByFullName ||
      assembly.assemblyStickerNumber) ? (
      <section className="order-detail-section" style={{ marginBottom: 16 }}>
        <h3>Сборка в системе</h3>
        <dl className="detail-dl">
          <dt>Собран</dt>
          <dd>
            {assembly.assembledAt ? new Date(assembly.assembledAt).toLocaleString('ru-RU') : '—'}
          </dd>
          <dt>Собрал</dt>
          <dd>{formatAssemblyWho(assembly)}</dd>
          <dt>Номер стикера</dt>
          <dd>{assembly.assemblyStickerNumber || '—'}</dd>
        </dl>
      </section>
    ) : null;
  const localLinesBlock =
    localLines?.length > 0 ? <LocalOrderLinesSection localLines={localLines} /> : null;
  if (mpNorm === 'ozon' && detail)
    return (
      <>
        {reserveBlock}
        {assemblyBlock}
        {localLinesBlock}
        <OzonDetail detail={detail} localLines={localLines} />
      </>
    );
  if ((mpNorm === 'wildberries' || mpNorm === 'wb') && detail) {
    return (
      <>
        {reserveBlock}
        {assemblyBlock}
        {localLinesBlock}
        {data.fromLocal && (
          <p className="order-detail-local-hint" style={{ marginBottom: 12, fontSize: 13, color: 'var(--muted)' }}>
            Детали с маркетплейса доступны только для заказов в статусе «Новый». Показаны сохранённые данные.
          </p>
        )}
        <WildberriesDetail detail={detail} localLines={localLines} />
      </>
    );
  }
  if ((mpNorm === 'yandex' || mpNorm === 'ym' || mpNorm === 'yandexmarket') && detail) {
    return (
      <>
        {reserveBlock}
        {assemblyBlock}
        {localLinesBlock}
        {data.fromLocal && (
          <p className="order-detail-local-hint" style={{ marginBottom: 12, fontSize: 13, color: 'var(--muted)' }}>
            Заказ не найден в API маркетплейса. Показаны сохранённые в системе данные.
          </p>
        )}
        <YandexDetail detail={detail} localLines={localLines} />
      </>
    );
  }
  return null;
}

export function OzonDetail({ detail, localLines }) {
  const dm = detail.delivery_method || {};
  const addressee = detail.addressee || {};
  const products = detail.products || [];
  const cancellation = detail.cancellation || {};

  return (
    <div className="order-detail-sections">
      <section className="order-detail-section">
        <h3>Основное</h3>
        <dl className="detail-dl">
          <dt>Номер отправления</dt><dd>{detail.posting_number}</dd>
          <dt>Номер заказа</dt><dd>{detail.order_number}</dd>
          <dt>Статус</dt><dd>{getOrderStatusLabel(detail.status)}</dd>
          {detail.substatus && <><dt>Подстатус</dt><dd>{detail.substatus}</dd></>}
          <dt>Время появления на маркетплейсе</dt><dd>{(detail.created_at || detail.in_process_at) ? new Date(detail.created_at || detail.in_process_at).toLocaleString('ru-RU') : '—'}</dd>
          <dt>В обработке с</dt><dd>{detail.in_process_at ? new Date(detail.in_process_at).toLocaleString('ru-RU') : '—'}</dd>
          <dt>Дата отгрузки</dt><dd>{detail.shipment_date ? new Date(detail.shipment_date).toLocaleString('ru-RU') : '—'}</dd>
        </dl>
      </section>

      {products.length > 0 && (
        <section className="order-detail-section">
          <h3>Товары</h3>
          <ul className="order-detail-products">
            {products.map((p, i) => {
              const erpPid = erpProductIdForOzonLine(localLines, p);
              return (
                <li key={i}>
                  <ProductTitleLink productId={erpPid}>
                    <strong>{p.name}</strong>
                  </ProductTitleLink>
                  <br />
                  Артикул: {p.offer_id}, SKU: {p.sku}, кол-во: {p.quantity}, цена: {p.price} {p.currency_code || 'RUB'}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {(dm.name || dm.warehouse) && (
        <section className="order-detail-section">
          <h3>Доставка</h3>
          <dl className="detail-dl">
            <dt>Способ</dt><dd>{dm.name || '—'}</dd>
            <dt>Склад</dt><dd>{dm.warehouse || '—'}</dd>
            {detail.tracking_number && <><dt>Трек-номер</dt><dd>{detail.tracking_number}</dd></>}
          </dl>
        </section>
      )}

      {(addressee.name || addressee.phone) && (
        <section className="order-detail-section">
          <h3>Получатель</h3>
          <dl className="detail-dl">
            {addressee.name && <><dt>Имя</dt><dd>{addressee.name}</dd></>}
            {addressee.phone && <><dt>Телефон</dt><dd>{addressee.phone}</dd></>}
          </dl>
        </section>
      )}

      {cancellation?.cancel_reason && (
        <section className="order-detail-section">
          <h3>Отмена</h3>
          <p>{cancellation.cancel_reason} {cancellation.cancellation_initiator && `(${cancellation.cancellation_initiator})`}</p>
        </section>
      )}
    </div>
  );
}

/** Краткая информация о заказе из списка (для ручных заказов, Яндекс или при ошибке API) */
export function OrderSummaryFromList({ orders, marketplace, onReserveChange }) {
  const mpName = marketplaceNames[marketplace] || marketplace;
  const orderId = marketplaceOrderIdForApi(orders, marketplace);
  const reserveFromList =
    orders?.length > 0
      ? {
          reservedQty: orders.reduce((s, o) => s + (Number(o.reservedQty ?? o.reserved_qty) || 0), 0),
          needQty: orders.reduce((s, o) => s + Math.max(1, Number(o.quantity) || 1), 0),
          hasReserve: orders.some((o) => (Number(o.reservedQty ?? o.reserved_qty) || 0) > 0),
          /** Без lines — панель подтянет детализацию с API; сводка X/Y уже по всем строкам заказа */
          lines: []
        }
      : null;
  return (
    <div className="order-detail-sections">
      {orderId && marketplace ? (
        <OrderReservePanel
          marketplace={marketplace}
          orderId={orderId}
          reserve={reserveFromList}
          onChanged={onReserveChange}
        />
      ) : null}
      <section className="order-detail-section">
        <h3>Данные заказа</h3>
        <dl className="detail-dl">
          <dt>Маркетплейс</dt><dd>{mpName}</dd>
          <dt>ID заказа</dt><dd>{orders?.[0]?.orderId ?? orders?.[0]?.order_id ?? '—'}</dd>
          <dt>Статус</dt><dd>{getOrderStatusLabel(orders?.[0]?.status)}</dd>
          <dt>Появился</dt><dd>{orders?.[0]?.createdAt ? new Date(orders[0].createdAt).toLocaleString('ru-RU') : '—'}</dd>
        </dl>
      </section>
      <section className="order-detail-section">
        <h3>Товары</h3>
        <ul className="order-detail-products">
          {(orders || []).map((o, i) => {
            const art = orderArticleFromLine(o);
            return (
            <li key={i}>
              <ProductTitleLink productId={o.productId ?? o.product_id}>
                <strong>{o.productName || o.product_name || '—'}</strong>
              </ProductTitleLink>
              <br />
              Количество: {o.quantity ?? 1}, цена: {o.price ?? '—'} ₽
              {art ? `, артикул: ${art}` : ''}
            </li>
            );
          })}
        </ul>
      </section>
      {orders?.[0]?.deliveryAddress || orders?.[0]?.delivery_address ? (
        <section className="order-detail-section">
          <h3>Доставка</h3>
          <p>{orders[0].deliveryAddress || orders[0].delivery_address}</p>
        </section>
      ) : null}
      {orders?.[0]?.customerName || orders?.[0]?.customer_name ? (
        <section className="order-detail-section">
          <h3>Получатель</h3>
          <dl className="detail-dl">
            <dt>Имя</dt><dd>{orders[0].customerName || orders[0].customer_name}</dd>
            {(orders[0].customerPhone || orders[0].customer_phone) && (
              <><dt>Телефон</dt><dd>{orders[0].customerPhone || orders[0].customer_phone}</dd></>
            )}
          </dl>
        </section>
      ) : null}
    </div>
  );
}

/** Даты Я.Маркета в ответе v2: «DD-MM-YYYY HH:mm:ss» */
function formatYandexApiDate(value) {
  if (value == null || value === '') return '—';
  const s = String(value);
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const [, dd, mm, yyyy, hh, mi, ss] = m;
    const d = new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`);
    return Number.isNaN(d.getTime()) ? s : d.toLocaleString('ru-RU');
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('ru-RU');
}

export function YandexDetail({ detail, localLines }) {
  const items = Array.isArray(detail.items) ? detail.items : [];
  const del = detail.delivery || {};
  const addr =
    del._localAddress ||
    del.courier?.address ||
    del.pickup?.address ||
    del.address;
  const addressLine = addr
    ? [addr.postcode, addr.city, addr.street, addr.house, addr.building, addr.apartment, addr.fullAddress]
        .filter(Boolean)
        .join(', ')
    : '';
  const buyer = detail.buyer || {};
  const buyerBasic = buyer.basicInfo || buyer.basic_info || buyer;

  return (
    <div className="order-detail-sections">
      <section className="order-detail-section">
        <h3>Основное</h3>
        <dl className="detail-dl">
          <dt>Номер заказа</dt>
          <dd>{detail.id ?? detail.orderId ?? '—'}</dd>
          <dt>Статус</dt>
          <dd>{detail.status ?? '—'}{detail.substatus ? ` / ${detail.substatus}` : ''}</dd>
          <dt>Создан</dt>
          <dd>{formatYandexApiDate(detail.creationDate)}</dd>
          <dt>Обновлён</dt>
          <dd>{formatYandexApiDate(detail.updatedAt)}</dd>
          {detail.currency && (
            <>
              <dt>Валюта</dt>
              <dd>{detail.currency}</dd>
            </>
          )}
          {detail.buyerTotal != null && (
            <>
              <dt>Сумма для покупателя</dt>
              <dd>{detail.buyerTotal}</dd>
            </>
          )}
        </dl>
      </section>

      {items.length > 0 && (
        <section className="order-detail-section">
          <h3>Товары</h3>
          <ul className="order-detail-products">
            {items.map((it, i) => {
              const erpPid = erpProductIdForYandexLine(localLines, it);
              return (
                <li key={it.id ?? i}>
                  <ProductTitleLink productId={erpPid}>
                    <strong>{it.offerName || it.offerId || '—'}</strong>
                  </ProductTitleLink>
                  <br />
                  Артикул (offerId): {it.offerId ?? '—'}
                  {it.shopSku != null && it.shopSku !== '' ? `, shopSku: ${it.shopSku}` : ''}
                  {`, кол-во: ${it.count ?? it.quantity ?? 1}`}
                  {it.price != null ? `, цена: ${it.price}` : ''}
                  {it.buyerPrice != null ? `, цена покупателя: ${it.buyerPrice}` : ''}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {addressLine && (
        <section className="order-detail-section">
          <h3>Доставка</h3>
          <p>{addressLine}</p>
          {del.type && <p className="text-muted" style={{ fontSize: 13 }}>Тип: {del.type}</p>}
        </section>
      )}

      {(buyerBasic?.firstName || buyerBasic?.lastName || buyerBasic?.phone) && (
        <section className="order-detail-section">
          <h3>Покупатель</h3>
          <dl className="detail-dl">
            {(buyerBasic.firstName || buyerBasic.lastName) && (
              <>
                <dt>Имя</dt>
                <dd>{[buyerBasic.firstName, buyerBasic.lastName].filter(Boolean).join(' ')}</dd>
              </>
            )}
            {buyerBasic.phone && (
              <>
                <dt>Телефон</dt>
                <dd>{buyerBasic.phone}</dd>
              </>
            )}
          </dl>
        </section>
      )}
    </div>
  );
}

export function WildberriesDetail({ detail, localLines }) {
  const address = detail.address || {};
  const offices = detail.offices || [];
  const qty = detail.quantity != null ? Number(detail.quantity) : 1;
  const productTitle = detail.productName || detail.nmName || detail.title || detail.article || '—';
  const linePid =
    localLines?.find((l) => l.productId != null && String(l.productId).trim() !== '')?.productId ?? null;
  const erpPid = erpProductIdForWb(localLines, detail) ?? linePid;

  return (
    <div className="order-detail-sections">
      <section className="order-detail-section">
        <h3>Основное</h3>
        <dl className="detail-dl">
          <dt>ID</dt><dd>{detail.id}</dd>
          <dt>Order UID</dt><dd>{detail.orderUid}</dd>
          <dt>Артикул</dt><dd>{detail.article}</dd>
          <dt>Время появления на маркетплейсе</dt><dd>{detail.createdAt ? new Date(detail.createdAt).toLocaleString('ru-RU') : '—'}</dd>
          <dt>Цена</dt><dd>{detail.price} {detail.convertedPrice != null && `(${detail.convertedPrice} коп.)`}</dd>
          <dt>Тип доставки</dt><dd>{detail.deliveryType || '—'}</dd>
          {detail.supplyId && <><dt>Поставка</dt><dd>{detail.supplyId}</dd></>}
        </dl>
      </section>

      <section className="order-detail-section">
        <h3>Товары</h3>
        <ul className="order-detail-products">
          <li>
            <ProductTitleLink productId={erpPid}>
              <strong>{productTitle}</strong>
            </ProductTitleLink>
            <br />
            Кол-во: {Number.isNaN(qty) ? 1 : Math.max(1, qty)}
            {detail.article ? `, артикул: ${detail.article}` : ''}
            {detail.nmId != null ? `, nmId: ${detail.nmId}` : ''}
          </li>
        </ul>
      </section>

      {address.fullAddress && (
        <section className="order-detail-section">
          <h3>Адрес</h3>
          <p>{address.fullAddress}</p>
        </section>
      )}

      {offices.length > 0 && (
        <section className="order-detail-section">
          <h3>ПВЗ</h3>
          <p>{offices.join(', ')}</p>
        </section>
      )}

      {detail.comment && (
        <section className="order-detail-section">
          <h3>Комментарий</h3>
          <p>{detail.comment}</p>
        </section>
      )}

      {detail.skus?.length > 0 && (
        <section className="order-detail-section">
          <h3>SKU</h3>
          <p>{detail.skus.join(', ')}</p>
        </section>
      )}
    </div>
  );
}
