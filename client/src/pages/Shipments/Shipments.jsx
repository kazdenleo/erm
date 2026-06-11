/**
 * Shipments Page (FBS)
 * Ozon, Яндекс — локальные поставки. WB — создание на маркетплейсе и добавление заказов.
 */

import React, { useState, useEffect } from 'react';
import { shipmentsApi, getQrStickerPrintUrl } from '../../services/shipments.api';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import './Shipments.css';

export function Shipments() {
  const [data, setData] = useState({ marketplaces: [], list: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMarketplace, setCreateMarketplace] = useState('wildberries');
  const [createName, setCreateName] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [closeLoadingId, setCloseLoadingId] = useState(null);
  const [openShipmentDetail, setOpenShipmentDetail] = useState(null);
  const [openDetailError, setOpenDetailError] = useState(null);
  const [removingOrderId, setRemovingOrderId] = useState(null);
  const [closeConfirm, setCloseConfirm] = useState(null);
  const [closeNotAssembledAction, setCloseNotAssembledAction] = useState('');
  const [closeCancelledAction, setCloseCancelledAction] = useState('');
  const [reapplyStockLoading, setReapplyStockLoading] = useState(false);

  const loadShipments = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await shipmentsApi.getAll();
      setData(result);
    } catch (e) {
      setError(e.message || 'Ошибка загрузки поставок');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadShipments();
  }, []);

  const handleCreate = async () => {
    setCreateLoading(true);
    setCreateError(null);
    try {
      await shipmentsApi.create(createMarketplace, createName || undefined);
      setCreateOpen(false);
      setCreateName('');
      await loadShipments();
    } catch (e) {
      setCreateError(e.response?.data?.message || e.message || 'Ошибка создания');
    } finally {
      setCreateLoading(false);
    }
  };

  const canClose = (shipment) => {
    return shipment.id && String(shipment.id).startsWith('ship-') && !shipment.closed;
  };

  const isLocalShipment = (shipment) => {
    return shipment.id && String(shipment.id).startsWith('ship-');
  };

  const canPrintShipmentSticker = (item) => {
    if (!item?.closed || !isLocalShipment(item)) return false;
    if (item.marketplace === 'wildberries') {
      return (item.orderIds?.length ?? item.productsCount ?? 0) > 0 || !!item.externalId || !!item.qrStickerPath;
    }
    return !!item.qrStickerPath;
  };

  const openShipmentDetailModal = (shipment) => {
    setOpenDetailError(null);
    setOpenShipmentDetail(shipment);
  };

  const handleReapplyStock = async (shipment) => {
    if (!shipment?.id || !shipment.closed) return;
    if (
      !window.confirm(
        'Повторно списать остатки по заказам этой поставки? Используйте, если при закрытии списание не прошло.'
      )
    ) {
      return;
    }
    setReapplyStockLoading(true);
    setOpenDetailError(null);
    try {
      const result = await shipmentsApi.reapplyStock(shipment.id);
      const processed = Number(result?.processed) || 0;
      const skipped = Number(result?.skipped) || 0;
      window.alert(
        `Готово: списано по ${processed} заказам, пропущено ${skipped}.` +
          (result?.errors?.length ? ` Ошибок: ${result.errors.length}` : '')
      );
      await loadShipments();
      const fresh = await shipmentsApi.getById(shipment.id);
      setOpenShipmentDetail(fresh);
    } catch (e) {
      setOpenDetailError(getApiErrorMessage(e, 'Не удалось списать остатки'));
    } finally {
      setReapplyStockLoading(false);
    }
  };

  const handleRemoveOrderFromShipment = async (orderId) => {
    if (!openShipmentDetail || openShipmentDetail.closed) return;
    setRemovingOrderId(orderId);
    try {
      const updated = await shipmentsApi.removeOrders(openShipmentDetail.id, [orderId]);
      setOpenShipmentDetail(updated);
      await loadShipments();
    } catch (e) {
      setOpenDetailError(e.response?.data?.message || e.message || 'Ошибка удаления заказа из поставки');
    } finally {
      setRemovingOrderId(null);
    }
  };

  const finishCloseShipment = async (shipment, options = {}) => {
    const updated = await shipmentsApi.close(shipment.id, options);
    if (updated?.qrStickerPath) {
      window.open(getQrStickerPrintUrl(shipment.id), '_blank', 'noopener,noreferrer');
    }
    setCloseConfirm(null);
    setCloseNotAssembledAction('');
    setCloseCancelledAction('');
    if (openShipmentDetail?.id === shipment.id) {
      setOpenShipmentDetail(updated);
    }
    await loadShipments();
  };

  const handleCloseShipment = async (shipment) => {
    if (!canClose(shipment)) return;
    setCloseLoadingId(shipment.id);
    setOpenDetailError(null);
    try {
      const preview = await shipmentsApi.getClosePreview(shipment.id);
      const hasNotAssembled = (preview?.notAssembled?.length ?? 0) > 0;
      const hasCancelled = (preview?.cancelled?.length ?? 0) > 0;
      if (hasNotAssembled || hasCancelled) {
        setCloseNotAssembledAction(hasNotAssembled ? '' : 'remove');
        setCloseCancelledAction(hasCancelled ? '' : 'keep');
        setOpenDetailError(null);
        setCloseConfirm({ shipment, preview });
        return;
      }
      await finishCloseShipment(shipment);
    } catch (e) {
      const details = e.response?.data?.details;
      if (e.response?.status === 409 && details?.code === 'SHIPMENT_CLOSE_CONFIRM_REQUIRED') {
        setCloseNotAssembledAction('');
        setCloseCancelledAction('');
        setOpenDetailError(null);
        setCloseConfirm({
          shipment,
          preview: {
            notAssembled: details.notAssembled || [],
            cancelled: details.cancelled || []
          }
        });
        return;
      }
      setOpenDetailError(getApiErrorMessage(e, 'Ошибка закрытия'));
    } finally {
      setCloseLoadingId(null);
    }
  };

  const handleConfirmCloseShipment = async () => {
    if (!closeConfirm?.shipment) return;
    const { shipment, preview } = closeConfirm;
    const hasNotAssembled = (preview?.notAssembled?.length ?? 0) > 0;
    const hasCancelled = (preview?.cancelled?.length ?? 0) > 0;
    if (hasNotAssembled && closeNotAssembledAction !== 'assemble' && closeNotAssembledAction !== 'remove') {
      return;
    }
    if (hasCancelled && closeCancelledAction !== 'remove' && closeCancelledAction !== 'keep') {
      return;
    }
    setCloseLoadingId(shipment.id);
    setOpenDetailError(null);
    try {
      const options = {};
      if (hasNotAssembled) options.notAssembled = closeNotAssembledAction;
      if (hasCancelled) options.cancelled = closeCancelledAction;
      await finishCloseShipment(shipment, options);
    } catch (e) {
      const msg = getApiErrorMessage(e, 'Ошибка закрытия');
      setOpenDetailError(msg);
      if (e.response?.status === 409 && e.response?.data?.details?.code === 'SHIPMENT_CLOSE_CONFIRM_REQUIRED') {
        setCloseConfirm({
          shipment,
          preview: {
            notAssembled: e.response.data.details.notAssembled || preview?.notAssembled || [],
            cancelled: e.response.data.details.cancelled || preview?.cancelled || []
          }
        });
      }
    } finally {
      setCloseLoadingId(null);
    }
  };

  if (loading) {
    return (
      <div className="card shipments-page">
        <div className="loading">Загрузка поставок...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card shipments-page">
        <div className="error">{error}</div>
      </div>
    );
  }

  const { marketplaces, list } = data;
  const listByCode = list || { ozon: [], wildberries: [], yandex: [] };

  return (
    <div className="card shipments-page">
      <div className="shipments-page-header">
        <div>
          <h1 className="title">📤 Поставки (FBS)</h1>
          <p className="subtitle">
            Ozon и Яндекс — локальные. WB — при закрытии поставка передаётся на маркетплейс; этикетка — по кнопке «Печать этикетки».
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          + Создать поставку
        </Button>
      </div>

      <div className="shipments-sections">
        {marketplaces.map(mp => {
          const items = listByCode[mp.code] ?? [];
          return (
            <section key={mp.code} className="shipments-section">
              <h2 className="shipments-section-title">
                <span className="shipments-section-icon">{mp.icon}</span>
                {mp.name}
                <span className="shipments-section-count">({items.length})</span>
              </h2>
              {items.length === 0 ? (
                <p className="shipments-empty">Нет поставок. Создайте поставку выше.</p>
              ) : (
                <table className="shipments-table table">
                  <thead>
                    <tr>
                      <th>ID / Название</th>
                      <th>Статус</th>
                      <th>Дата создания</th>
                      <th>Заказов</th>
                      <th>Действия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, idx) => (
                      <tr key={item.id ?? item.externalId ?? idx}>
                        <td>
                          <button
                            type="button"
                            className="shipments-name-link"
                            onClick={() => openShipmentDetailModal(item)}
                          >
                            {item.name ?? item.id ?? '—'}
                          </button>
                        </td>
                        <td>{item.closed ? 'Закрыта' : (item.status ?? '—')}</td>
                        <td>{item.createdAt ? formatDate(item.createdAt) : '—'}</td>
                        <td>{item.productsCount ?? (item.orderIds?.length ?? 0)}</td>
                        <td>
                          <div className="shipments-row-actions">
                            {canClose(item) && (
                              <Button
                                variant="secondary"
                                size="small"
                                onClick={() => handleCloseShipment(item)}
                                disabled={closeLoadingId === item.id}
                              >
                                {closeLoadingId === item.id ? 'Закрытие...' : 'Закрыть поставку'}
                              </Button>
                            )}
                            {canPrintShipmentSticker(item) && (
                              <a
                                href={getQrStickerPrintUrl(item.id)}
                                target="_blank"
                                rel="noreferrer"
                                className="shipments-qr-link"
                                title={
                                  item.wbLastSyncError
                                    ? `${item.wbLastSyncError}. При открытии выполним передачу на WB и загрузку этикетки.`
                                    : 'Печать этикетки поставки (передача на WB при необходимости)'
                                }
                              >
                                🖨️ Печать этикетки
                              </a>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
      </div>

      <Modal
        isOpen={createOpen}
        onClose={() => { setCreateOpen(false); setCreateError(null); }}
        title="Создать поставку"
      >
        <div className="shipments-modal-form">
          {createError && <div className="error" style={{ marginBottom: 12 }}>{createError}</div>}
          <label>
            Маркетплейс
            <select
              value={createMarketplace}
              onChange={e => setCreateMarketplace(e.target.value)}
              className="shipments-select"
            >
              <option value="ozon">Ozon</option>
              <option value="wildberries">Wildberries</option>
              <option value="yandex">Яндекс.Маркет</option>
            </select>
          </label>
          <label>
            Название (необязательно)
            <input
              type="text"
              value={createName}
              onChange={e => setCreateName(e.target.value)}
              placeholder="Поставка №1"
              className="shipments-input"
            />
          </label>
          <div className="shipments-modal-actions">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Отмена</Button>
            <Button variant="primary" onClick={handleCreate} disabled={createLoading}>
              {createLoading ? 'Создание...' : 'Создать'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={!!closeConfirm}
        onClose={() => {
          if (closeLoadingId) return;
          setCloseConfirm(null);
          setCloseNotAssembledAction('');
          setCloseCancelledAction('');
        }}
        title="Закрытие поставки"
        size="large"
        closeOnBackdropClick={!closeLoadingId}
        closeOnEscape={!closeLoadingId}
      >
        {closeConfirm && (
          <div className="shipments-close-confirm">
            {(closeConfirm.preview?.staleInShipment?.length ?? 0) > 0 && (
              <section className="shipments-close-section">
                <h3 className="shipments-close-section-title">Заказы вне сборки</h3>
                <p className="shipments-close-hint">
                  Эти заказы уже в пути, в закупке или отгружены — при закрытии будут автоматически убраны из поставки:
                </p>
                <ul className="shipments-close-order-list">
                  {closeConfirm.preview.staleInShipment.map((o) => (
                    <li key={o.orderId}>
                      <span className="shipments-detail-order-id">{o.orderId}</span>
                      {o.productName ? <span className="shipments-close-product"> — {o.productName}</span> : null}
                      <span className="shipments-close-status"> ({o.statusLabel || o.status})</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {(closeConfirm.preview?.notAssembled?.length ?? 0) > 0 && (
              <section className="shipments-close-section">
                <h3 className="shipments-close-section-title">Несобранные заказы</h3>
                <p className="shipments-close-hint">
                  В поставке есть заказы, которые ещё не в статусе «Собран». Выберите действие:
                </p>
                <ul className="shipments-close-order-list">
                  {closeConfirm.preview.notAssembled.map((o) => (
                    <li key={o.orderId}>
                      <span className="shipments-detail-order-id">{o.orderId}</span>
                      {o.productName ? <span className="shipments-close-product"> — {o.productName}</span> : null}
                      <span className="shipments-close-status"> ({o.statusLabel || o.status})</span>
                    </li>
                  ))}
                </ul>
                <div className="shipments-close-radios">
                  <label>
                    <input
                      type="radio"
                      name="notAssembledAction"
                      value="assemble"
                      checked={closeNotAssembledAction === 'assemble'}
                      onChange={() => setCloseNotAssembledAction('assemble')}
                    />
                    Отметить собранными и закрыть поставку
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="notAssembledAction"
                      value="remove"
                      checked={closeNotAssembledAction === 'remove'}
                      onChange={() => setCloseNotAssembledAction('remove')}
                    />
                    Удалить из поставки
                  </label>
                </div>
              </section>
            )}

            {(closeConfirm.preview?.cancelled?.length ?? 0) > 0 && (
              <section className="shipments-close-section">
                <h3 className="shipments-close-section-title">Отменённые заказы</h3>
                <p className="shipments-close-hint">В поставке есть отменённые заказы:</p>
                <ul className="shipments-close-order-list">
                  {closeConfirm.preview.cancelled.map((o) => (
                    <li key={o.orderId}>
                      <span className="shipments-detail-order-id">{o.orderId}</span>
                      {o.productName ? <span className="shipments-close-product"> — {o.productName}</span> : null}
                    </li>
                  ))}
                </ul>
                <div className="shipments-close-radios">
                  <label>
                    <input
                      type="radio"
                      name="cancelledAction"
                      value="remove"
                      checked={closeCancelledAction === 'remove'}
                      onChange={() => setCloseCancelledAction('remove')}
                    />
                    Убрать из поставки
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="cancelledAction"
                      value="keep"
                      checked={closeCancelledAction === 'keep'}
                      onChange={() => setCloseCancelledAction('keep')}
                    />
                    Оставить в поставке (без списания со склада)
                  </label>
                </div>
              </section>
            )}

            {openDetailError && (
              <div className="error" style={{ marginTop: 12 }}>{openDetailError}</div>
            )}

            <div className="shipments-modal-actions" style={{ marginTop: 16 }}>
              <Button
                variant="secondary"
                onClick={() => {
                  setCloseConfirm(null);
                  setCloseNotAssembledAction('');
                  setCloseCancelledAction('');
                  setOpenDetailError(null);
                }}
                disabled={!!closeLoadingId}
              >
                Отмена
              </Button>
              <Button
                variant="primary"
                onClick={handleConfirmCloseShipment}
                disabled={
                  !!closeLoadingId ||
                  ((closeConfirm.preview?.notAssembled?.length ?? 0) > 0 &&
                    closeNotAssembledAction !== 'assemble' &&
                    closeNotAssembledAction !== 'remove') ||
                  ((closeConfirm.preview?.cancelled?.length ?? 0) > 0 &&
                    closeCancelledAction !== 'remove' &&
                    closeCancelledAction !== 'keep')
                }
              >
                {closeLoadingId ? 'Закрытие…' : 'Закрыть поставку'}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={!!openShipmentDetail}
        onClose={() => { setOpenShipmentDetail(null); setOpenDetailError(null); }}
        title={openShipmentDetail ? `Поставка: ${openShipmentDetail.name ?? openShipmentDetail.id}` : 'Поставка'}
        size="large"
      >
        <div className="shipments-detail">
          {openDetailError && <div className="error" style={{ marginBottom: 12 }}>{openDetailError}</div>}
          {openShipmentDetail && (
            <>
              <p className="shipments-detail-meta">
                Статус: {openShipmentDetail.closed ? 'Закрыта' : (openShipmentDetail.status ?? '—')}
                {' · '}
                Заказов: {openShipmentDetail.orderIds?.length ?? 0}
              </p>
              {!openShipmentDetail.orderIds?.length ? (
                <p className="shipments-empty">В поставке нет заказов.</p>
              ) : (
                <div className="shipments-orders-in-shipment">
                  <p>Заказы в поставке (можно удалить из поставки):</p>
                  <ul className="shipments-detail-orders-list">
                    {openShipmentDetail.orderIds.map(orderId => (
                      <li key={orderId} className="shipments-detail-order-row">
                        <span className="shipments-detail-order-id">{orderId}</span>
                        {!openShipmentDetail.closed && isLocalShipment(openShipmentDetail) && (
                          <Button
                            variant="secondary"
                            size="small"
                            onClick={() => handleRemoveOrderFromShipment(orderId)}
                            disabled={removingOrderId === orderId}
                          >
                            {removingOrderId === orderId ? 'Удаление...' : 'Удалить из поставки'}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="shipments-modal-actions" style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {openShipmentDetail.closed && isLocalShipment(openShipmentDetail) && (
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={reapplyStockLoading}
                    onClick={() => handleReapplyStock(openShipmentDetail)}
                  >
                    {reapplyStockLoading ? 'Списание…' : 'Списать остатки повторно'}
                  </Button>
                )}
                <Button variant="secondary" onClick={() => setOpenShipmentDetail(null)}>Закрыть</Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}

function formatDate(v) {
  if (!v) return '—';
  try {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('ru-RU');
  } catch {
    return String(v);
  }
}
