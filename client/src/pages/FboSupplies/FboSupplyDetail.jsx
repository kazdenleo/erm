/**
 * Карточка поставки FBO
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { useOrganizations } from '../../hooks/useOrganizations';
import { useWarehouses } from '../../hooks/useWarehouses';
import { Button } from '../../components/common/Button/Button';
import {
  FBO_SUPPLY_STATUS_ORDER,
  getFboSupplyStatusLabel,
  getMarketplaceLabel,
} from '../../constants/fboSupplyStatuses';
import './FboSupplies.css';

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString().slice(0, 10);
}

function fmtDt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function FboSupplyDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { organizations } = useOrganizations();
  const { warehouses } = useWarehouses();
  const [supply, setSupply] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [stockMsg, setStockMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await fboSuppliesApi.getById(id);
      setSupply(data);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось загрузить поставку');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const saveField = async (patch) => {
    setSaving(true);
    try {
      const data = await fboSuppliesApi.update(id, patch);
      setSupply(data);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const handleAdvance = async () => {
    try {
      setStockMsg(null);
      const data = await fboSuppliesApi.advanceStatus(id);
      setSupply(data);
      const sd = data?.stockDeduction;
      if (sd?.applied) {
        setStockMsg(`Списано остатков по ${sd.deductedLines} строкам.`);
      } else if (data.status === 'shipped' && data.deductStock && sd?.error) {
        setStockMsg(sd.error);
      } else if (data.status === 'shipped' && data.deductStock && sd?.reason === 'already_deducted') {
        setStockMsg('Остатки уже были списаны ранее.');
      }
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось сменить статус');
    }
  };

  if (loading) return <div className="fbo-supplies-page">Загрузка…</div>;
  if (!supply) {
    return (
      <div className="fbo-supplies-page">
        <p>{err || 'Поставка не найдена'}</p>
        <Button variant="secondary" onClick={() => navigate('/fbo-supplies')}>
          К списку
        </Button>
      </div>
    );
  }

  const statusIdx = FBO_SUPPLY_STATUS_ORDER.indexOf(supply.status);

  return (
    <div className="fbo-supplies-page">
      <div className="fbo-supplies-toolbar">
        <Button variant="secondary" size="small" onClick={() => navigate('/fbo-supplies')}>
          ← К списку
        </Button>
        <h2 style={{ margin: 0, flex: 1 }}>
          Поставка FBO № {supply.id}
          {supply.externalShipmentNumber ? ` · ${supply.externalShipmentNumber}` : ''}
        </h2>
        <Button variant="primary" size="small" onClick={handleAdvance} disabled={statusIdx >= FBO_SUPPLY_STATUS_ORDER.length - 2}>
          Следующий шаг →
        </Button>
      </div>

      {err && <div className="alert alert-danger">{err}</div>}
      {stockMsg && (
        <div className={`alert ${stockMsg.includes('Списано') ? 'alert-success' : 'alert-warning'}`}>
          {stockMsg}
        </div>
      )}
      {supply.status === 'shipped' && supply.deductStock && (
        <p className="muted" style={{ fontSize: 13, marginTop: -8 }}>
          {supply.stockDeductedAt
            ? `Остатки списаны: ${fmtDt(supply.stockDeductedAt)}`
            : 'Включено списание остатков — укажите склад списания и привязанные товары, затем переведите в «Отгружен».'}
        </p>
      )}

      <div className="fbo-status-stepper">
        {FBO_SUPPLY_STATUS_ORDER.filter((s) => s !== 'return').map((s, i) => {
          const done = i < statusIdx;
          const active = s === supply.status;
          return (
            <span key={s} className={`fbo-status-step${active ? ' active' : ''}${done ? ' done' : ''}`}>
              {getFboSupplyStatusLabel(s)}
            </span>
          );
        })}
      </div>

      <div className="fbo-supply-meta">
        <div>
          <label>Маркетплейс</label>
          <div>{getMarketplaceLabel(supply.marketplace)}</div>
        </div>
        <div>
          <label>Название</label>
          <input
            className="form-control form-control-sm"
            value={supply.name || ''}
            onChange={(e) => setSupply((s) => ({ ...s, name: e.target.value }))}
            onBlur={() => saveField({ name: supply.name })}
            disabled={saving}
          />
        </div>
        <div>
          <label>Дата готовности</label>
          <input
            type="date"
            className="form-control form-control-sm"
            value={fmtDate(supply.readyAt)}
            onChange={(e) => {
              const v = e.target.value || null;
              setSupply((s) => ({ ...s, readyAt: v }));
              saveField({ readyAt: v });
            }}
            disabled={saving}
          />
        </div>
        <div>
          <label>Склад маркетплейса</label>
          <input
            className="form-control form-control-sm"
            value={supply.marketplaceWarehouseName || ''}
            onChange={(e) => setSupply((s) => ({ ...s, marketplaceWarehouseName: e.target.value }))}
            onBlur={() => saveField({ marketplaceWarehouseName: supply.marketplaceWarehouseName })}
            disabled={saving}
          />
        </div>
        <div>
          <label>Номер отгрузки</label>
          <div>{supply.externalShipmentNumber || '—'}</div>
        </div>
        <div>
          <label>Организация</label>
          <select
            className="form-select form-select-sm"
            value={supply.organizationId ?? ''}
            onChange={(e) => {
              const v = e.target.value ? Number(e.target.value) : null;
              setSupply((s) => ({ ...s, organizationId: v }));
              saveField({ organizationId: v });
            }}
            disabled={saving}
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
          <label>Склад списания остатков</label>
          <select
            className="form-select form-select-sm"
            value={supply.deductionWarehouseId ?? ''}
            onChange={(e) => {
              const v = e.target.value ? Number(e.target.value) : null;
              setSupply((s) => ({ ...s, deductionWarehouseId: v }));
              saveField({ deductionWarehouseId: v });
            }}
            disabled={saving}
          >
            <option value="">—</option>
            {(warehouses || [])
              .filter((w) => w.type === 'warehouse' && !w.supplierId)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label>Списать остатки</label>
          <div className="form-check form-switch">
            <input
              className="form-check-input"
              type="checkbox"
              checked={!!supply.deductStock}
              onChange={(e) => {
                const v = e.target.checked;
                setSupply((s) => ({ ...s, deductStock: v }));
                saveField({ deductStock: v });
              }}
              disabled={saving}
            />
          </div>
        </div>
        <div>
          <label>Создана</label>
          <div>{fmtDt(supply.createdAt)}</div>
        </div>
      </div>

      <h3 style={{ fontSize: 16, marginBottom: 12 }}>Товары поставки</h3>
      <div className="table-responsive">
        <table className="table table-sm table-hover">
          <thead>
            <tr>
              <th>Фото</th>
              <th>Название</th>
              <th>Артикул</th>
              <th>Штрихкод</th>
              <th>Кол-во</th>
            </tr>
          </thead>
          <tbody>
            {(supply.items || []).map((it) => (
              <tr key={it.id}>
                <td>
                  {it.productImage ? (
                    <img src={it.productImage} alt="" style={{ width: 40, height: 40, objectFit: 'cover' }} />
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  {it.productName || it.name || '—'}
                  {!it.productId && <span className="fbo-import-warn"> (не привязан)</span>}
                </td>
                <td>{it.sku || '—'}</td>
                <td>{it.barcode || '—'}</td>
                <td>{it.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
