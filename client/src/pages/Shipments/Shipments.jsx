/**
 * Shipments Page (FBS)
 * Ozon, Яндекс — локальные поставки. WB — создание на маркетплейсе и добавление заказов.
 */

import React, { useState, useEffect } from 'react';
import { shipmentsApi, getQrStickerPrintUrl } from '../../services/shipments.api';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
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

  const openShipmentDetailModal = (shipment) => {
    setOpenDetailError(null);
    setOpenShipmentDetail(shipment);
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

  const handleCloseShipment = async (shipment) => {
    if (!canClose(shipment)) return;
    setCloseLoadingId(shipment.id);
    try {
      const updated = await shipmentsApi.close(shipment.id);
      await loadShipments();
      if (updated?.qrStickerPath) {
        window.open(getQrStickerPrintUrl(shipment.id), '_blank', 'noopener,noreferrer');
      }
    } catch (e) {
      setOpenDetailError(e.response?.data?.message || e.message || 'Ошибка закрытия');
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
          <p className="subtitle">Ozon и Яндекс — локальные. WB — создание на маркетплейсе и добавление заказов.</p>
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
                            {item.closed && item.qrStickerPath && (
                              <a
                                href={getQrStickerPrintUrl(item.id)}
                                target="_blank"
                                rel="noreferrer"
                                className="shipments-qr-link"
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
              <div className="shipments-modal-actions" style={{ marginTop: 16 }}>
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
