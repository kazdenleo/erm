/**
 * Предпросмотр позиций перед созданием закупки из расчёта FBO
 */

import React, { useMemo } from 'react';
import { Modal } from '../../components/common/Modal/Modal';
import { Button } from '../../components/common/Button/Button';
import { getPurchaseRowDisplayName } from './fboPurchaseCalcUtils';

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseDraftQty(raw) {
  if (raw === '' || raw == null) return 0;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(99999, n);
}

export function FboPurchaseCreateModal({
  isOpen,
  saving,
  rows = [],
  qtyByKey = {},
  onQtyChange,
  suppliers = [],
  organizations = [],
  warehouses = [],
  supplierId,
  organizationId,
  warehouseId,
  onSupplierChange,
  onOrganizationChange,
  onWarehouseChange,
  error,
  onClose,
  onConfirm,
}) {
  const totals = useMemo(() => {
    return rows.reduce(
      (acc, row) => {
        const qty = parseDraftQty(qtyByKey[row.key]);
        const cost = Number(row.cost) || 0;
        acc.onHand += Number(row.onHand) || 0;
        acc.need += Number(row.supplyQtyTotal) || 0;
        acc.incoming += Number(row.incoming) || 0;
        acc.toPurchase += qty;
        acc.costSum += Math.round(qty * cost * 100) / 100;
        if (qty > 0) acc.lines += 1;
        return acc;
      },
      { onHand: 0, need: 0, incoming: 0, toPurchase: 0, costSum: 0, lines: 0 }
    );
  }, [rows, qtyByKey]);

  const destWarehouses = (warehouses || []).filter((w) => w.type === 'warehouse' && !w.supplierId);

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => !saving && onClose()}
      title="Предпросмотр закупки"
      size="xl"
    >
      <p className="text-muted small" style={{ marginTop: 0 }}>
        Проверьте количества перед созданием закупки. «Итого к закупке» можно изменить — в документ
        попадут только строки с количеством больше нуля.
      </p>

      {error ? <div className="alert alert-danger py-2">{error}</div> : null}

      <div className="fbo-pc-preview-table-wrap">
        <table className="table table-sm table-bordered fbo-pc-preview-table">
          <thead>
            <tr>
              <th>Товар</th>
              <th>Артикул</th>
              <th className="text-end" title="Остаток на складе">
                Наличие
              </th>
              <th className="text-end" title="Сумма по выбранным поставкам FBO">
                Нужно для поставок
              </th>
              <th className="text-end" title="Ожидается по закупкам (в пути)">
                В пути
              </th>
              <th className="text-end">Итого к закупке</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center text-muted">
                  Нет выбранных позиций
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const qtyRaw = qtyByKey[row.key] ?? '';
                const qty = parseDraftQty(qtyRaw);
                const purchased = Number(row.purchasedQty) || 0;
                const suggested = Number(row.remainingToPurchase ?? row.toPurchase) || 0;
                return (
                  <tr key={row.key}>
                    <td className="fbo-pc-preview-name">
                      <div className={row.rowType === 'component' ? 'fbo-pc-kit-component-name' : 'fbo-pc-plain-name'}>
                        {row.rowType === 'component' ? (
                          <span className="fbo-pc-kit-component-marker" aria-hidden>
                            ↳
                          </span>
                        ) : null}
                        <span className="fbo-pc-name" title={getPurchaseRowDisplayName(row)}>
                          {getPurchaseRowDisplayName(row)}
                        </span>
                      </div>
                      {purchased > 0 ? (
                        <div className="text-muted small">Уже оформлено: {purchased} шт.</div>
                      ) : null}
                    </td>
                    <td>{row.sku || '—'}</td>
                    <td className="text-end">{row.onHand ?? 0}</td>
                    <td className="text-end">{row.supplyQtyTotal ?? 0}</td>
                    <td className="text-end">{row.incoming ?? 0}</td>
                    <td className="text-end">
                      <input
                        type="number"
                        min={0}
                        max={99999}
                        step={1}
                        className="form-control form-control-sm fbo-pc-preview-qty"
                        value={qtyRaw}
                        disabled={saving}
                        aria-label={`К закупке ${row.sku || getPurchaseRowDisplayName(row)}`}
                        title={suggested > 0 ? `По расчёту: ${suggested} шт.` : undefined}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === '') {
                            onQtyChange(row.key, '');
                            return;
                          }
                          const n = parseInt(v, 10);
                          if (!Number.isFinite(n) || n < 0) return;
                          onQtyChange(row.key, String(Math.min(99999, n)));
                        }}
                      />
                      {qty > 0 && Number(row.cost) > 0 ? (
                        <div className="text-muted small">{fmtMoney(qty * Number(row.cost))}</div>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={2} className="text-end">
                Итого
              </th>
              <th className="text-end">{totals.onHand}</th>
              <th className="text-end">{totals.need}</th>
              <th className="text-end">{totals.incoming}</th>
              <th className="text-end">
                <strong>{totals.toPurchase}</strong>
                <div className="text-muted small fw-normal">{fmtMoney(totals.costSum)}</div>
              </th>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="fbo-pc-preview-fields">
        <div>
          <label className="form-label">Поставщик</label>
          <select
            className="form-select form-select-sm"
            value={supplierId}
            disabled={saving}
            onChange={(e) => onSupplierChange(e.target.value)}
          >
            <option value="">— выберите —</option>
            {(suppliers || []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.code || `#${s.id}`}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="form-label">Организация</label>
          <select
            className="form-select form-select-sm"
            value={organizationId}
            disabled={saving}
            onChange={(e) => onOrganizationChange(e.target.value)}
          >
            <option value="">—</option>
            {(organizations || []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="form-label">Склад назначения</label>
          <select
            className="form-select form-select-sm"
            value={warehouseId}
            disabled={saving}
            onChange={(e) => onWarehouseChange(e.target.value)}
          >
            <option value="">—</option>
            {destWarehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.address || w.name || `#${w.id}`}
                {w.isFboStock ? ' (FBO)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="d-flex justify-content-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          Отмена
        </Button>
        <Button variant="primary" onClick={onConfirm} disabled={saving || totals.lines === 0}>
          {saving ? 'Создание…' : `Создать закупку (${totals.lines})`}
        </Button>
      </div>
    </Modal>
  );
}

export { parseDraftQty };
