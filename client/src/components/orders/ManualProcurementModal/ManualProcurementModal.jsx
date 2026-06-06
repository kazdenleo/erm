/**
 * Модалка ручного выбора поставщика для позиций с дефицитом (manual_required).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '../common/Modal/Modal';
import { Button } from '../common/Button/Button';
import { ordersApi } from '../../services/orders.api';
import { purchasesApi } from '../../services/purchases.api';
import { suppliersApi } from '../../services/suppliers.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage';

function lineLabel(line) {
  const sku = line?.productSku || line?.product_sku;
  const name = line?.productName || line?.product_name;
  if (sku && name) return `${sku} — ${name}`;
  return sku || name || `Товар №${line?.productId}`;
}

export function ManualProcurementModal({
  isOpen,
  onClose,
  marketplace,
  orderId,
  onSuccess,
  contextOrganizationId,
  organizations = [],
  warehouses = [],
  loadWarehouses,
}) {
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [lines, setLines] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [draftPurchases, setDraftPurchases] = useState([]);
  const [choice, setChoice] = useState('existing');
  const [existingPurchaseId, setExistingPurchaseId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');

  const warehouseOptions = useMemo(
    () => (warehouses || []).filter((w) => w?.type === 'warehouse' && !w?.supplier_id),
    [warehouses]
  );

  const deficitLines = useMemo(
    () => (lines || []).filter((l) => Number(l.deficit) > 0),
    [lines]
  );

  const loadData = useCallback(async () => {
    if (!marketplace || !orderId) return;
    setLoading(true);
    setError(null);
    try {
      const [linesRes, drafts, supRes] = await Promise.all([
        ordersApi.getProcurementLines(marketplace, orderId),
        purchasesApi.list({ activeOnly: true, limit: 50 }),
        suppliersApi.getAll(),
      ]);
      const rawLines = linesRes?.lines || [];
      setLines(
        rawLines
          .filter((l) => Number(l.deficit) > 0)
          .map((l) => ({
            ...l,
            quantity: Number(l.deficit) || 1,
          }))
      );
      const listDrafts = Array.isArray(drafts) ? drafts : [];
      setDraftPurchases(listDrafts);
      setChoice(listDrafts.length > 0 ? 'existing' : 'new');
      if (listDrafts.length > 0) {
        setExistingPurchaseId(String(listDrafts[0].id));
      }
      const rawSup =
        supRes && supRes.ok && Array.isArray(supRes.data)
          ? supRes.data
          : Array.isArray(supRes)
            ? supRes
            : [];
      setSuppliers(rawSup);
    } catch (e) {
      setError(getApiErrorMessage(e, 'Не удалось загрузить позиции для закупки'));
      setLines([]);
    } finally {
      setLoading(false);
    }
  }, [marketplace, orderId]);

  useEffect(() => {
    if (!isOpen) return;
    setSupplierId('');
    setOrganizationId('');
    setWarehouseId('');
    loadData();
  }, [isOpen, loadData]);

  useEffect(() => {
    if (!isOpen || choice !== 'new') return;
    if (organizationId) return;
    const so = contextOrganizationId;
    if (!so) return;
    if (!(organizations || []).some((o) => String(o.id) === String(so))) return;
    setOrganizationId(String(so));
    if (typeof loadWarehouses === 'function') {
      loadWarehouses(String(so)).catch(() => {});
    }
  }, [isOpen, choice, organizationId, contextOrganizationId, organizations, loadWarehouses]);

  useEffect(() => {
    if (!isOpen || choice !== 'new' || warehouseId) return;
    if (warehouseOptions.length === 1) {
      setWarehouseId(String(warehouseOptions[0].id));
    }
  }, [isOpen, choice, warehouseId, warehouseOptions]);

  const setLineQuantity = (lineKey, value) => {
    const n = Math.max(0, parseInt(value, 10) || 0);
    setLines((prev) =>
      prev.map((l) => {
        if (l.lineKey !== lineKey) return l;
        const max = Number(l.deficit) || 1;
        return { ...l, quantity: Math.min(max, n) };
      })
    );
  };

  const handleSubmit = async () => {
    if (!marketplace || !orderId) return;
    const active = deficitLines.filter((l) => Number(l.quantity) > 0);
    if (!active.length) {
      setError('Нет позиций с количеством к закупке');
      return;
    }
    if (choice === 'existing') {
      const pid = parseInt(existingPurchaseId, 10);
      if (!Number.isInteger(pid) || pid < 1) {
        setError('Выберите открытую закупку');
        return;
      }
    } else {
      if (!String(supplierId || '').trim()) {
        setError('Выберите поставщика');
        return;
      }
      if (!String(organizationId || '').trim()) {
        setError('Выберите организацию');
        return;
      }
      if (!String(warehouseId || '').trim()) {
        setError('Выберите склад');
        return;
      }
    }

    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        items: active.map((l) => ({
          lineKey: l.lineKey,
          quantity: Math.max(1, parseInt(l.quantity, 10) || 1),
        })),
      };
      if (choice === 'existing') {
        payload.existingPurchaseId = parseInt(existingPurchaseId, 10);
        const draft = draftPurchases.find((d) => String(d.id) === String(existingPurchaseId));
        if (draft?.supplier_id != null) {
          payload.supplierId = draft.supplier_id;
        } else if (draft?.supplierId != null) {
          payload.supplierId = draft.supplierId;
        } else {
          setError('У выбранной закупки не указан поставщик');
          setSubmitting(false);
          return;
        }
      } else {
        payload.supplierId = parseInt(String(supplierId).trim(), 10);
        payload.organizationId = parseInt(String(organizationId).trim(), 10);
        payload.warehouseId = parseInt(String(warehouseId).trim(), 10);
      }

      const result = await ordersApi.manualProcure(marketplace, orderId, payload);
      onSuccess?.(result?.message || 'Ручная закупка оформлена');
      onClose?.();
    } catch (e) {
      setError(getApiErrorMessage(e, 'Не удалось оформить закупку'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Ручная закупка · заказ ${orderId}`}
      size="xl"
    >
      <div className="orders-procurement-modal orders-manual-procurement-modal">
        {error ? (
          <div className="error" style={{ marginBottom: 12 }}>
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="loading">Загрузка позиций…</div>
        ) : deficitLines.length === 0 ? (
          <p className="muted">Нет позиций с дефицитом — ручная закупка не требуется.</p>
        ) : (
          <>
            <p className="muted" style={{ marginBottom: 12, fontSize: 14 }}>
              Автоматически закупить не удалось. Выберите поставщика и подтвердите количество по
              каждой позиции (не больше дефицита).
            </p>

            <table className="orders-procurement-table" style={{ marginBottom: 16 }}>
              <thead>
                <tr>
                  <th>Товар</th>
                  <th>Нужно</th>
                  <th>Резерв</th>
                  <th>Закуплено</th>
                  <th>Дефицит</th>
                  <th>К закупке</th>
                  <th>Подсказка</th>
                </tr>
              </thead>
              <tbody>
                {deficitLines.map((line) => (
                  <tr key={line.lineKey}>
                    <td>
                      {lineLabel(line)}
                      {line.kitProductId ? (
                        <div className="text-muted" style={{ fontSize: 12 }}>
                          комплект: {line.kitSku || line.kitName || line.kitProductId}
                        </div>
                      ) : null}
                      {line.manualReason ? (
                        <div className="text-muted" style={{ fontSize: 12 }}>
                          {line.manualReason}
                        </div>
                      ) : null}
                    </td>
                    <td>{line.quantityNeeded}</td>
                    <td>{line.quantityReserved}</td>
                    <td>{line.quantityPurchased}</td>
                    <td>
                      <strong>{line.deficit}</strong>
                    </td>
                    <td>
                      <input
                        type="number"
                        className="form-control orders-procurement-qty-input"
                        min={1}
                        max={line.deficit}
                        value={line.quantity}
                        onChange={(e) => setLineQuantity(line.lineKey, e.target.value)}
                      />
                    </td>
                    <td className="text-muted" style={{ fontSize: 12, maxWidth: 180 }}>
                      {(line.suggestedSuppliers || [])
                        .slice(0, 2)
                        .map((s) => s.name)
                        .join(', ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {draftPurchases.length > 0 ? (
              <div className="form-group" style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="manualProcurementChoice"
                      checked={choice === 'existing'}
                      onChange={() => setChoice('existing')}
                    />
                    Добавить в открытую закупку
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="manualProcurementChoice"
                      checked={choice === 'new'}
                      onChange={() => setChoice('new')}
                    />
                    Новая закупка
                  </label>
                </div>
              </div>
            ) : null}

            {choice === 'existing' && draftPurchases.length > 0 ? (
              <div className="form-group" style={{ marginBottom: 12 }}>
                <label className="label">Открытая закупка *</label>
                <select
                  className="form-control"
                  style={{ maxWidth: 420 }}
                  value={existingPurchaseId}
                  onChange={(e) => setExistingPurchaseId(e.target.value)}
                >
                  {draftPurchases.map((d) => (
                    <option key={d.id} value={String(d.id)}>
                      №{d.id}
                      {d.supplier_name || d.supplierName ? ` · ${d.supplier_name || d.supplierName}` : ''}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {choice === 'new' || draftPurchases.length === 0 ? (
              <>
                <div className="form-group" style={{ marginBottom: 12 }}>
                  <label className="label">Поставщик *</label>
                  <select
                    className="form-control"
                    style={{ maxWidth: 420 }}
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                  >
                    <option value="">— Выберите поставщика —</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={String(s.id)}>
                        {s.name || `Поставщик №${s.id}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ marginBottom: 12 }}>
                  <label className="label">Организация *</label>
                  <select
                    className="form-control"
                    style={{ maxWidth: 420 }}
                    value={organizationId}
                    onChange={(e) => {
                      setOrganizationId(e.target.value);
                      setWarehouseId('');
                      if (e.target.value && typeof loadWarehouses === 'function') {
                        loadWarehouses(e.target.value).catch(() => {});
                      }
                    }}
                  >
                    <option value="">— Выберите —</option>
                    {(organizations || []).map((o) => (
                      <option key={o.id} value={String(o.id)}>
                        {o.name || o.short_name || `№${o.id}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ marginBottom: 12 }}>
                  <label className="label">Склад *</label>
                  <select
                    className="form-control"
                    style={{ maxWidth: 420 }}
                    value={warehouseId}
                    onChange={(e) => setWarehouseId(e.target.value)}
                  >
                    <option value="">— Выберите —</option>
                    {warehouseOptions.map((w) => (
                      <option key={w.id} value={String(w.id)}>
                        {w.name || `Склад №${w.id}`}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : null}

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <Button variant="primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Оформление…' : 'Оформить закупку'}
              </Button>
              <Button variant="secondary" onClick={onClose} disabled={submitting}>
                Отмена
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

export default ManualProcurementModal;
