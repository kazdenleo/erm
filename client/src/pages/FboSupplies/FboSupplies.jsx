/**
 * Список поставок FBO
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { Button } from '../../components/common/Button/Button';
import { FboSupplyImportModal } from './FboSupplyImportModal';
import { getFboSupplyStatusLabel, getMarketplaceLabel } from '../../constants/fboSupplyStatuses';
import './FboSupplies.css';

function fmtDt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('ru-RU');
}

export function FboSupplies() {
  const navigate = useNavigate();
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [importMode, setImportMode] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await fboSuppliesApi.list();
      setList(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось загрузить список');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="fbo-supplies-page">
      <div className="fbo-supplies-toolbar">
        <h2 style={{ margin: 0, flex: 1 }}>Поставки FBO</h2>
        <Button
          variant="secondary"
          onClick={async () => {
            try {
              const blob = await fboSuppliesApi.downloadImportTemplate();
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `fbo_supplies_template_${new Date().toISOString().slice(0, 10)}.xlsx`;
              a.click();
              URL.revokeObjectURL(url);
            } catch (e) {
              setErr(e.response?.data?.message || e.message || 'Не удалось скачать шаблон');
            }
          }}
        >
          Шаблон Excel
        </Button>
        <Button variant="secondary" onClick={() => setImportMode('excel')}>
          Загрузить Excel
        </Button>
        <Button variant="primary" onClick={() => setImportMode('api')}>
          Загрузить с маркетплейса
        </Button>
      </div>

      {err && <div className="alert alert-danger">{err}</div>}

      {loading ? (
        <p>Загрузка…</p>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm table-hover">
            <thead>
              <tr>
                <th>№</th>
                <th>Номер отгрузки</th>
                <th>Маркетплейс</th>
                <th>Название</th>
                <th>Дата готовности</th>
                <th>Склад МП</th>
                <th>Организация</th>
                <th>Товаров</th>
                <th>Статус</th>
                <th>Создана</th>
              </tr>
            </thead>
            <tbody>
              {!list.length && (
                <tr>
                  <td colSpan={10} className="text-center muted">
                    Нет поставок. Загрузите из Excel или с маркетплейса.
                  </td>
                </tr>
              )}
              {list.map((row) => (
                <tr
                  key={row.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/fbo-supplies/${row.id}`)}
                >
                  <td>{row.id}</td>
                  <td>{row.externalShipmentNumber}</td>
                  <td>{getMarketplaceLabel(row.marketplace)}</td>
                  <td>{row.name || '—'}</td>
                  <td>{fmtDate(row.readyAt)}</td>
                  <td>{row.marketplaceWarehouseName || '—'}</td>
                  <td>{row.organizationName || '—'}</td>
                  <td>{row.itemCount ?? '—'}</td>
                  <td>
                    <span className="badge bg-light text-dark">{getFboSupplyStatusLabel(row.status)}</span>
                  </td>
                  <td>{fmtDt(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <FboSupplyImportModal
        open={!!importMode}
        mode={importMode}
        onClose={() => setImportMode(null)}
        onImported={() => load()}
      />
    </div>
  );
}
