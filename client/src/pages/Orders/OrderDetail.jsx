/**
 * Order Detail Page
 * Карточка заказа: Ozon (v3/posting/fbs/get), Wildberries (api/v3/orders/new), Яндекс.Маркет (GET v2/campaigns/.../orders/...)
 */

import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { useProductCardModal } from '../../context/ProductCardModalContext.jsx';
import { ordersApi } from '../../services/orders.api';
import { Button } from '../../components/common/Button/Button';
import { ManualProcurementModal } from '../../components/orders/ManualProcurementModal/ManualProcurementModal';
import { useWarehouses } from '../../hooks/useWarehouses';
import { useOrganizations } from '../../hooks/useOrganizations';
import {
  getOrderStatusLabel,
  isOrderStatusEligibleForSupplierOrder,
} from '../../constants/orderStatuses';
import { marketplaceOrderIdForApi, marketplaceRouteSegment } from '../../utils/orderListGroupKey';
import {
  groupReserveCoverageKind,
  reserveBadgeClassName
} from '../../utils/orderReserveBadge.js';
import { orderCanShowCancel, orderDeleteConfirmMessage } from '../../utils/orderActions.js';
import './OrderDetail.css';

function orderReserveLineKey(line) {
  const rowId = line.orderRowDbId ?? line.order_row_db_id ?? '';
  return `${rowId || (line.orderLineId ?? '')}-${line.productId}-${line.lineKind}`;
}

function lineReserveDisplayUnits(line) {
  const perKit = Math.max(1, Number(line.perKitQty ?? line.per_kit_qty) || 1);
  const kind = line.lineKind;
  if ((kind === 'kit' || kind === 'kit_whole') && perKit <= 1) {
    const reserved = Math.max(0, Number(line.reservedQty) || 0);
    const need = Math.max(0, Number(line.needQty) || 0);
    return {
      perKit: 1,
      reserveInKitUnits: true,
      reserved,
      need,
      reservedPieces: reserved,
      needPieces: need,
      pieceHint: null,
    };
  }
  if (line.lineKind === 'component' && perKit > 1) {
    const reservedPieces = Math.max(0, Number(line.reservedQty) || 0);
    const needPieces = Math.max(0, Number(line.needQty) || 0);
    const need =
      line.needKitUnits != null
        ? Math.max(0, Number(line.needKitUnits) || 0)
        : Math.max(0, Math.ceil(needPieces / perKit));
    return {
      perKit,
      reserveInKitUnits: true,
      reserved: Math.floor(reservedPieces / perKit),
      need,
      reservedPieces,
      needPieces,
      pieceHint: `${reservedPieces} шт`,
    };
  }
  return {
    perKit: 1,
    reserveInKitUnits: false,
    reserved: Math.max(0, Number(line.reservedQty) || 0),
    need: Math.max(0, Number(line.needQty) || 0),
    reservedPieces: Math.max(0, Number(line.reservedQty) || 0),
    needPieces: Math.max(0, Number(line.needQty) || 0),
    pieceHint: null,
  };
}

function lineReserveBounds(line) {
  const units = lineReserveDisplayUnits(line);
  const { reserved, need, reserveInKitUnits, perKit } = units;
  const remaining = Math.max(0, need - reserved);
  const availablePieces =
    line.availableQty != null && !Number.isNaN(Number(line.availableQty))
      ? Math.max(0, Number(line.availableQty))
      : reserveInKitUnits
        ? remaining * perKit
        : remaining;
  const available = reserveInKitUnits
    ? Math.floor(availablePieces / perKit)
    : availablePieces;
  const maxReserve = Math.min(remaining, available);
  const remainingPieces = Math.max(0, units.needPieces - units.reservedPieces);
  const inputMax = reserveInKitUnits
    ? Math.min(remainingPieces, Math.max(0, availablePieces))
    : maxReserve;
  return {
    ...units,
    remaining,
    available,
    availablePieces,
    maxReserve,
    remainingPieces,
    inputMax,
  };
}

function lineReserveUnreserveMax(line) {
  const b = lineReserveBounds(line);
  return Math.max(0, Number(b.reservedPieces) || Number(line.reservedQty) || 0);
}

/** Количество для API: резерв в штуках (приращение за одну операцию). */
function lineReserveApiQuantity(line, uiQty, { unreserve = false } = {}) {
  const q = Math.max(1, parseInt(uiQty, 10) || 1);
  const b = lineReserveBounds(line);
  if (unreserve) {
    return Math.min(q, Math.max(0, b.reservedPieces));
  }
  const headroomPieces = Math.max(0, b.remainingPieces);
  return Math.min(q, headroomPieces > 0 ? headroomPieces : q);
}

/** Для резерва комплекта по kitProductId API ждёт число комплектов, не штук. */
function lineReserveApiKitUnits(line, uiQty, { unreserve = false } = {}) {
  const pieces = lineReserveApiQuantity(line, uiQty, { unreserve });
  const perKit = Math.max(1, Number(line.perKitQty ?? line.per_kit_qty) || 1);
  const b = lineReserveBounds(line);
  const kitUnits = Math.max(1, Math.ceil(pieces / perKit));
  if (unreserve) {
    const reservedKits = Math.max(0, Number(b.reserved) || 0);
    return reservedKits > 0 ? Math.min(kitUnits, reservedKits) : kitUnits;
  }
  const headroomKits = Math.max(0, b.remaining);
  return headroomKits > 0 ? Math.min(kitUnits, headroomKits) : kitUnits;
}

function clampLineQty(raw, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function shouldShowOrderAssemblySection(assembly) {
  if (!assembly || typeof assembly !== 'object') return false;
  return Boolean(
    assembly.onAssembly ||
      assembly.assembledAt ||
      assembly.assembledByEmail ||
      assembly.assembledByFullName ||
      assembly.assemblyStickerNumber
  );
}

/** Отмена на МП + удаление записи из ERM (без отмены на МП). */
export function OrderCardActions({
  marketplace,
  orderId,
  status,
  onDeleted,
  onCancelled,
  onError,
  onSupplierOrdered,
  onOpenManualProcurement,
}) {
  const { profile } = useAuth();
  const supplierSyncEnabled = profile?.supplier_sync_enabled !== false;
  const [cancelLoading, setCancelLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [supplierOrderLoading, setSupplierOrderLoading] = useState(false);
  const [supplierSubmitLoading, setSupplierSubmitLoading] = useState(false);
  const busy = cancelLoading || deleteLoading || supplierOrderLoading || supplierSubmitLoading;
  const showCancel = orderCanShowCancel(marketplace, status);
  const showSupplierOrder =
    supplierSyncEnabled && isOrderStatusEligibleForSupplierOrder(marketplace, status);

  const handleSendToProcurement = async () => {
    if (
      !window.confirm(
        'Отправить заказ в закупку? Сначала будет зарезервировано доступное количество (склад и «в пути»), затем создана закупка только на недостающее.'
      )
    ) {
      return;
    }
    setSupplierOrderLoading(true);
    try {
      const result = await ordersApi.sendToProcurement(marketplace, orderId);
      onSupplierOrdered?.(result);
      if (result?.manualLines?.length) {
        onOpenManualProcurement?.();
      }
    } catch (e) {
      const msg = e.response?.data?.message || e.message || 'Не удалось отправить заказ в закупку';
      onError?.(msg);
      if (e.response?.status === 422 || e.response?.data?.details?.manualLines?.length) {
        onOpenManualProcurement?.();
      }
    } finally {
      setSupplierOrderLoading(false);
    }
  };

  const handleSubmitToSupplier = async () => {
    setSupplierSubmitLoading(true);
    try {
      const result = await ordersApi.submitToSupplier(marketplace, orderId);
      onSupplierOrdered?.(result);
    } catch (e) {
      const msg = e.response?.data?.message || e.message || 'Не удалось отправить заказ поставщику';
      onError?.(msg);
    } finally {
      setSupplierSubmitLoading(false);
    }
  };

  const handleCancel = async () => {
    if (
      !window.confirm(
        'Отменить заказ? В системе статус станет «Отменён»; для Ozon, Wildberries и Яндекс.Маркета будет отправлен запрос отмены продавца в API маркетплейса (если статус допускает отмену).'
      )
    ) {
      return;
    }
    setCancelLoading(true);
    try {
      await ordersApi.cancelOrder(marketplace, orderId);
      onCancelled?.();
    } catch (e) {
      onError?.(e.response?.data?.message || e.message || 'Не удалось отменить заказ');
    } finally {
      setCancelLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(orderDeleteConfirmMessage(marketplace))) return;
    setDeleteLoading(true);
    try {
      await ordersApi.deleteOrder(marketplace, orderId);
      onDeleted?.();
    } catch (e) {
      onError?.(e.response?.data?.message || e.message || 'Не удалось удалить заказ');
    } finally {
      setDeleteLoading(false);
    }
  };

  if (!marketplace || !orderId) return null;

  return (
    <section className="order-detail-actions" aria-label="Действия с заказом">
      <div className="order-detail-actions__buttons">
        {showSupplierOrder ? (
          <>
            <Button variant="primary" size="small" onClick={handleSendToProcurement} disabled={busy}>
              {supplierOrderLoading ? 'Отправка…' : 'Отправить в закупку'}
            </Button>
            <Button variant="secondary" size="small" onClick={handleSubmitToSupplier} disabled={busy}>
              {supplierSubmitLoading ? 'Отправка…' : 'Отправить поставщику'}
            </Button>
            <Button
              variant="secondary"
              size="small"
              onClick={() => onOpenManualProcurement?.()}
              disabled={busy}
            >
              Выбрать поставщика
            </Button>
          </>
        ) : null}
        {showCancel ? (
          <Button variant="danger" size="small" onClick={handleCancel} disabled={busy}>
            {cancelLoading ? 'Отмена…' : 'Отменить заказ'}
          </Button>
        ) : null}
        <Button variant="secondary" size="small" onClick={handleDelete} disabled={busy}>
          {deleteLoading ? 'Удаление…' : 'Удалить из системы'}
        </Button>
      </div>
      <p className="order-detail-actions-hint">
        {showSupplierOrder
          ? '«Отправить в закупку» — только в ERM: резерв и строка в локальной закупке, без API поставщика. «Отправить поставщику» — этот заказ в Mikado / Moskvorechie (только его позиции, не вся закупка). '
          : ''}
        «Удалить из системы» убирает заказ из ERM и не отменяет его на маркетплейсе. «Отменить» — отмена в
        системе и запрос отмены на МП (если доступно).
      </p>
    </section>
  );
}

function OrderAssemblySection({ assembly }) {
  if (!shouldShowOrderAssemblySection(assembly)) return null;
  return (
    <section className="order-detail-section" style={{ marginBottom: 16 }}>
      <h3>Сборка в системе</h3>
      <dl className="detail-dl">
        {assembly.assembledAt ? (
          <>
            <dt>Собран</dt>
            <dd>{new Date(assembly.assembledAt).toLocaleString('ru-RU')}</dd>
            <dt>Собрал</dt>
            <dd>{formatAssemblyWho(assembly)}</dd>
          </>
        ) : null}
        <dt>Номер стикера</dt>
        <dd>{assembly.assemblyStickerNumber || '—'}</dd>
      </dl>
    </section>
  );
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
    setLineQty((prev) => {
      const next = { ...prev };
      let dirty = false;
      for (const line of detailLines) {
        const key = orderReserveLineKey(line);
        const b = lineReserveBounds(line);
        const hasPieces =
          (Number(line.reservedQty) || 0) > 0 ||
          b.reserved > 0 ||
          (line.lineKind === 'component' && (Number(line.reservedQty) || 0) > 0);
        const canAddMore = b.remaining > 0 && b.inputMax > 0;
        const canRemove = b.reserved > 0 || b.reservedPieces > 0;
        const defaultQty =
          canAddMore && canRemove
            ? Math.min(
                b.remainingPieces > 0 ? b.remainingPieces : b.remaining,
                b.inputMax > 0 ? b.inputMax : 1
              )
            : canRemove
              ? lineReserveUnreserveMax(line)
              : b.inputMax > 0
                ? b.inputMax
                : 1;
        if (next[key] == null || next[key] === '') {
          next[key] = defaultQty;
          dirty = true;
        }
      }
      return dirty ? next : prev;
    });
  }, [reserve?.reservedQty, reserve?.needQty, detailLines.length]);

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
    const isUnreserve = String(action || '').toLowerCase() === 'unreserve';
    const reserveViaKit =
      line?.lineKind === 'component' &&
      line?.kitReserveFromComponents &&
      !isUnreserve &&
      line?.kitProductId;
    let pid = line?.productId;
    if (reserveViaKit) {
      pid = line.kitProductId;
    }
    if (!marketplace || !orderId || !pid || lineLoadingKey) return;
    const key = orderReserveLineKey(line);
    const b = lineReserveBounds(line);
    const act = String(action || '').toLowerCase();
    const isUnreserveAct = act === 'unreserve';
    const max = isUnreserveAct ? lineReserveUnreserveMax(line) : b.inputMax;
    if (max <= 0) return;
    const qty =
      qtyOverride != null
        ? clampLineQty(qtyOverride, 1, max)
        : clampLineQty(lineQty[key], 1, max);
    const reserveAsKitUnits =
      line?.lineKind === 'kit' ||
      line?.lineKind === 'kit_whole' ||
      reserveViaKit;
    const apiQty = reserveAsKitUnits
      ? lineReserveApiKitUnits(line, qty, { unreserve: isUnreserveAct })
      : lineReserveApiQuantity(line, qty, { unreserve: isUnreserveAct });

    setLineLoadingKey(key);
    setError(null);
    setFeedback(null);
    try {
      const result = await ordersApi.setOrderReserve(marketplace, orderId, {
        action: isUnreserveAct ? 'unreserve' : 'reserve',
        productId: pid,
        quantity: apiQty
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
  const summaryCoverage =
    reserve?.reserveCoverage ??
    reserve?.reserve_coverage ??
    groupReserveCoverageKind(detailLines);

  return (
    <section className="order-detail-section order-reserve-panel" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: '1 1 200px' }}>
          <h3 style={{ margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            Резерв на складе
            {needQty > 0 && reservedQty > 0 ? (
              <span
                className={reserveBadgeClassName(summaryCoverage)}
                title={
                  summaryCoverage === 'on_hand'
                    ? 'Со склада (в наличии)'
                    : summaryCoverage === 'incoming'
                      ? 'С участием товара в пути'
                      : 'Резерв без покрытия остатком'
                }
              >
                {reservedQty}/{needQty}
              </span>
            ) : null}
          </h3>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted, #666)' }}>
            {needQty > 0
              ? `Зарезервировано по заказу: ${reservedQty} из ${needQty}`
              : reserve == null
                ? 'Загрузка…'
                : 'Нет данных о количестве'}
          </p>
          {needQty > 0 && reservedQty > 0 ? (
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--muted, #888)' }}>
              {summaryCoverage === 'on_hand'
                ? 'Плашка зелёная — резерв покрыт наличием на складе.'
                : summaryCoverage === 'incoming'
                  ? 'Плашка серая — в резерве есть товар «в пути».'
                  : 'Плашка жёлтая — резерв есть, но на складе и в закупках товара нет; снимите резерв или добавьте поставку.'}
            </p>
          ) : null}
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
            const bounds = lineReserveBounds(line);
            const {
              reserved: r,
              need: n,
              reservedPieces,
              needPieces,
              remaining,
              remainingPieces,
              available,
              availablePieces,
              reserveInKitUnits,
              perKit,
            } = bounds;
            const badgeReserved = reserveInKitUnits ? reservedPieces : r;
            const badgeNeed = reserveInKitUnits ? needPieces : n;
            const pieceHint = lineReserveDisplayUnits(line).pieceHint;
            const lineHas =
              r > 0 || (reserveInKitUnits && (lineReserveDisplayUnits(line).reservedPieces || 0) > 0);
            const lineCoverage =
              line.reserveCoverage ?? line.reserve_coverage ?? (lineHas ? 'incoming' : 'none');
            const canAddMore = remaining > 0 && bounds.inputMax > 0;
            const canRemove = r > 0 || reservedPieces > 0;
            const inputMaxAdd = bounds.inputMax;
            const inputMaxRemove = lineReserveUnreserveMax(line);
            const inputMaxPieces =
              canAddMore && canRemove
                ? Math.max(inputMaxAdd, inputMaxRemove)
                : canRemove
                  ? inputMaxRemove
                  : inputMaxAdd;
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
            const qtyDefaultAdd = Math.min(
              remainingPieces > 0 ? remainingPieces : remaining,
              inputMaxAdd > 0 ? inputMaxAdd : 1
            );
            const qtyDefault =
              canAddMore && !canRemove
                ? qtyDefaultAdd
                : canRemove && !canAddMore
                  ? Math.max(1, inputMaxRemove)
                  : canAddMore && canRemove
                    ? qtyDefaultAdd
                    : 1;
            const qtyVal = lineQty[key] ?? qtyDefault;
            const lineActionsEnabled = canReserve && (canAddMore || canRemove);
            return (
              <li
                key={key}
                className="order-reserve-line"
              >
                <span className="order-reserve-line__title">
                  {title}:{' '}
                  {badgeReserved > 0 ? (
                    <span className={reserveBadgeClassName(lineCoverage)} style={{ marginRight: 4 }}>
                      {badgeReserved}/{badgeNeed}
                    </span>
                  ) : (
                    <>
                      <strong>{badgeReserved}</strong> из {badgeNeed}
                    </>
                  )}
                  {pieceHint ? (
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}> ({pieceHint})</span>
                  ) : null}
                  {line.compositionHint ? (
                    <span style={{ display: 'block', color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
                      {String(line.compositionHint).startsWith('Состав: ')
                        ? (
                          <>
                            Состав:
                            <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
                              {String(line.compositionHint)
                                .slice(9)
                                .split('; ')
                                .filter(Boolean)
                                .map((part) => (
                                  <li key={part}>{part}</li>
                                ))}
                            </ul>
                          </>
                        )
                        : line.compositionHint}
                    </span>
                  ) : null}
                  {!canReserve ? (
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                      {' '}
                      — привяжите товар в каталоге (артикул в карточке товара или сопоставление МП)
                    </span>
                  ) : canAddMore ? (
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                      {' '}
                      (доступно к резерву:{' '}
                      {reserveInKitUnits
                        ? `${available} компл.${
                            perKit > 1 && availablePieces > 0 ? ` / ${availablePieces} шт` : ''
                          }`
                        : available}
                      {line.lineKind === 'kit' && line.kitReserveFromComponents
                        ? ', из комплектующих'
                        : ''}
                      , осталось:{' '}
                      {reserveInKitUnits
                        ? `${remaining} компл.${remainingPieces > 0 ? ` / ${remainingPieces} шт` : ''}`
                        : remaining}
                      )
                    </span>
                  ) : remaining > 0 && !canAddMore ? (
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}> — нет доступного остатка</span>
                  ) : null}
                </span>
                <div className="order-reserve-line__actions">
                  <label className="order-reserve-line__qty">
                    <span className="visually-hidden">Количество</span>
                    <input
                      type="number"
                      className="form-control form-control-sm"
                      min={1}
                      max={inputMaxPieces > 0 ? inputMaxPieces : 1}
                      value={inputMaxPieces > 0 ? qtyVal : 0}
                      disabled={
                        loading ||
                        lineLoadingKey === key ||
                        inputMaxPieces <= 0 ||
                        !lineActionsEnabled
                      }
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw === '') {
                          setLineQty((prev) => ({ ...prev, [key]: '' }));
                          return;
                        }
                        const n = parseInt(raw, 10);
                        if (!Number.isFinite(n)) return;
                        setLineQty((prev) => ({
                          ...prev,
                          [key]: Math.min(Math.max(1, n), Math.max(1, inputMaxPieces))
                        }));
                      }}
                    />
                    <span className="order-reserve-line__qty-suffix">
                      {reserveInKitUnits ? 'компл.' : 'шт.'}
                    </span>
                  </label>
                  {canRemove ? (
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={
                        loading ||
                        lineLoadingKey === key ||
                        inputMaxRemove <= 0 ||
                        !lineActionsEnabled
                      }
                      onClick={() => handleLineAction(line, 'unreserve')}
                    >
                      {lineLoadingKey === key ? '…' : 'Снять'}
                    </Button>
                  ) : null}
                  {canAddMore ? (
                    <Button
                      variant="primary"
                      size="small"
                      disabled={
                        loading ||
                        lineLoadingKey === key ||
                        inputMaxAdd <= 0 ||
                        !lineActionsEnabled
                      }
                      onClick={() => handleLineAction(line, 'reserve')}
                    >
                      {lineLoadingKey === key ? '…' : 'В резерв'}
                    </Button>
                  ) : null}
                  {canAddMore && inputMaxAdd >= 1 && lineActionsEnabled ? (
                    <button
                      type="button"
                      className="order-reserve-line__max-btn"
                      disabled={loading || lineLoadingKey === key}
                      onClick={() => {
                        setLineQty((prev) => ({ ...prev, [key]: inputMaxAdd }));
                        handleLineAction(line, 'reserve', inputMaxAdd);
                      }}
                    >
                      Весь заказ
                    </button>
                  ) : null}
                  {canRemove && inputMaxRemove >= 1 && lineActionsEnabled ? (
                    <button
                      type="button"
                      className="order-reserve-line__max-btn"
                      disabled={loading || lineLoadingKey === key}
                      onClick={() => {
                        setLineQty((prev) => ({ ...prev, [key]: inputMaxRemove }));
                        handleLineAction(line, 'unreserve', inputMaxRemove);
                      }}
                    >
                      Снять всё
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {feedback && (
        <p
          style={{
            margin: '8px 0 0',
            fontSize: 13,
            color: /недостаточно|не изменён|не снят/i.test(feedback)
              ? 'var(--danger, #c62828)'
              : 'var(--success, #2e7d32)',
          }}
        >
          {feedback}
        </p>
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
  const { selectedOrganizationId: contextOrganizationId } = useAuth();
  const { warehouses, loadWarehouses } = useWarehouses();
  const { organizations } = useOrganizations();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [manualProcOpen, setManualProcOpen] = useState(false);
  const [procMessage, setProcMessage] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const quick = await ordersApi.getOrderDetail(marketplace, orderId, { fast: true });
        if (cancelled) return;
        setData(quick);
        setLoading(false);
        const resolvedMp = quick?.marketplace ? marketplaceRouteSegment(quick.marketplace) : '';
        const urlMp = marketplaceRouteSegment(marketplace);
        if (resolvedMp && urlMp && resolvedMp !== urlMp) {
          navigate(`/orders/${resolvedMp}/${encodeURIComponent(orderId)}`, { replace: true });
          return;
        }
        try {
          const full = await ordersApi.getOrderDetail(marketplace, orderId);
          if (!cancelled) {
            setData((prev) => ({ ...(prev || {}), ...full }));
            const fullMp = full?.marketplace ? marketplaceRouteSegment(full.marketplace) : '';
            if (fullMp && urlMp && fullMp !== urlMp) {
              navigate(`/orders/${fullMp}/${encodeURIComponent(orderId)}`, { replace: true });
            }
          }
        } catch (e) {
          if (cancelled) return;
          const hasLocal =
            (quick?.localLines?.length ?? 0) > 0 ||
            quick?.reserve ||
            quick?.ermStatus ||
            quick?.detail;
          if (!hasLocal) {
            setError(e.response?.data?.message || e.message || 'Ошибка загрузки заказа');
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(e.response?.data?.message || e.message || 'Ошибка загрузки заказа');
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [marketplace, orderId, navigate]);

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

      <OrderCardActions
        marketplace={marketplace}
        orderId={orderId}
        status={data?.ermStatus}
        onDeleted={() => navigate('/orders')}
        onCancelled={() => {
          ordersApi
            .getOrderDetail(marketplace, orderId)
            .then((result) => setData(result))
            .catch((e) => setError(e.response?.data?.message || e.message || 'Ошибка загрузки заказа'));
        }}
        onError={(msg) => setError(msg)}
        onOpenManualProcurement={() => setManualProcOpen(true)}
        onSupplierOrdered={(result) => {
          setProcMessage(result?.message || null);
          ordersApi
            .getOrderDetail(marketplace, orderId)
            .then((result) => setData(result))
            .catch(() => {});
        }}
      />

      {procMessage ? (
        <div className="info" style={{ marginBottom: 12 }}>
          {procMessage}
        </div>
      ) : null}

      <ManualProcurementModal
        isOpen={manualProcOpen}
        onClose={() => setManualProcOpen(false)}
        marketplace={marketplace}
        orderId={orderId}
        contextOrganizationId={contextOrganizationId}
        organizations={organizations}
        warehouses={warehouses}
        loadWarehouses={loadWarehouses}
        onSuccess={(msg) => {
          setProcMessage(msg);
          ordersApi
            .getOrderDetail(marketplace, orderId)
            .then((result) => setData(result))
            .catch(() => {});
        }}
      />

      <OrderReservePanel
        marketplace={marketplace}
        orderId={orderId}
        reserve={data?.reserve}
        onChanged={(r) => setData((d) => (d ? { ...d, reserve: r } : d))}
      />

      <OrderAssemblySection assembly={data?.assembly} />

      {mpKey === 'ozon' && detail && (
        <OzonDetail detail={detail} localLines={localLines} />
      )}
      {(mpKey === 'wildberries' || mpKey === 'wb') && detail && (
        <WildberriesDetail
          detail={detail}
          localLines={localLines}
          assemblyStickerNumber={data?.assembly?.assemblyStickerNumber}
        />
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
  const assemblyBlock = <OrderAssemblySection assembly={assembly} />;
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
        <WildberriesDetail
          detail={detail}
          localLines={localLines}
          assemblyStickerNumber={assembly?.assemblyStickerNumber}
        />
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
  return (
    <>
      {reserveBlock}
      {assemblyBlock}
      {localLinesBlock}
      {!detail && (
        <p className="order-detail-local-hint" style={{ marginBottom: 12, fontSize: 13, color: 'var(--muted)' }}>
          Детали с маркетплейса не загружены. Резерв и позиции — по данным из системы.
        </p>
      )}
    </>
  );
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
  const lineNeed = (o) => Math.max(1, Number(o.needQty ?? o.need_qty ?? o.quantity) || 1);
  const reserveFromList =
    orders?.length > 0
      ? {
          reservedQty: orders.reduce((s, o) => s + (Number(o.reservedQty ?? o.reserved_qty) || 0), 0),
          needQty: orders.reduce((s, o) => s + lineNeed(o), 0),
          hasReserve: orders.some((o) => (Number(o.reservedQty ?? o.reserved_qty) || 0) > 0),
          lines: orders.flatMap((o) => {
            const rl = o.reserveLines ?? o.reserve_lines;
            return Array.isArray(rl) ? rl : [];
          })
        }
      : null;
  return (
    <div className="order-detail-sections">
      {orderId && marketplace ? (
        <OrderReservePanel
          marketplace={marketplace}
          orderId={orderId}
          reserve={reserveFromList}
          onChanged={(r) => {
            onReserveChange?.(r);
          }}
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
          <dd>
            {getOrderStatusLabel(detail.status)}
            {detail.substatus ? ` / ${detail.substatus}` : ''}
          </dd>
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

export function WildberriesDetail({ detail, localLines, assemblyStickerNumber = null }) {
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
          {assemblyStickerNumber != null && String(assemblyStickerNumber).trim() !== '' ? (
            <>
              <dt>Номер стикера</dt>
              <dd>{assemblyStickerNumber}</dd>
            </>
          ) : null}
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
