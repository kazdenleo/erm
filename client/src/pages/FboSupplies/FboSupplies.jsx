/**
 * Список поставок FBO
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { Button } from '../../components/common/Button/Button';
import { FboSupplyImportModal } from './FboSupplyImportModal';
import { getFboSupplyStatusLabel, getMarketplaceLabel } from '../../constants/fboSupplyStatuses';
import { FboSupplyReserveBreakdown } from './FboSupplyReserveBreakdown.jsx';
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
  const [templateLoading, setTemplateLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [calcLoading, setCalcLoading] = useState(false);
  const [openCalcSessions, setOpenCalcSessions] = useState([]);
  const [deletingId, setDeletingId] = useState(null);

  const loadOpenCalcSessions = useCallback(async () => {
    try {
      const data = await fboSuppliesApi.listPurchaseCalcSessions();
      setOpenCalcSessions(Array.isArray(data) ? data : []);
    } catch {
      setOpenCalcSessions([]);
    }
  }, []);

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
    void loadOpenCalcSessions();
  }, [load, loadOpenCalcSessions]);

  const handleDeleteSupply = async (supplyId, e) => {
    e?.stopPropagation?.();
    if (!window.confirm('Удалить поставку? Связанные строки и грузоместа будут удалены.')) return;
    setDeletingId(supplyId);
    setErr(null);
    try {
      await fboSuppliesApi.delete(supplyId);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(String(supplyId));
        return next;
      });
      await load();
    } catch (ex) {
      setErr(ex.response?.data?.message || ex.message || 'Не удалось удалить поставку');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="fbo-supplies-page">
      <div className="fbo-supplies-toolbar">
        <h2 style={{ margin: 0, flex: 1 }}>Поставки FBO</h2>
        <Button
          variant="secondary"
          disabled={templateLoading}
          onClick={async () => {
            setTemplateLoading(true);
            setErr(null);
            try {
              const { buffer, filename } = await fboSuppliesApi.downloadImportTemplate();
              const blob = new Blob([buffer], {
                type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download =
                filename?.includes('artikul') ? filename : `fbo_postavka_artikul_kolichestvo_${new Date().toISOString().slice(0, 10)}.xlsx`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(url);
            } catch (e) {
              let msg = e.response?.data?.message || e.message || 'Не удалось скачать шаблон';
              if (e.response?.data instanceof ArrayBuffer) {
                try {
                  const txt = new TextDecoder().decode(e.response.data);
                  const j = JSON.parse(txt);
                  msg = j.message || j.error || msg;
                } catch {
                  /* ignore */
                }
              }
              setErr(msg);
            } finally {
              setTemplateLoading(false);
            }
          }}
        >
          {templateLoading ? 'Скачивание…' : 'Шаблон Excel'}
        </Button>
        <Button variant="secondary" onClick={() => setImportMode('excel')}>
          Загрузить Excel
        </Button>
        <Button variant="primary" onClick={() => setImportMode('api')}>
          Загрузить с маркетплейса
        </Button>
        <Button
          variant="secondary"
          disabled={!selectedIds.size || calcLoading}
          onClick={async () => {
            setCalcLoading(true);
            setErr(null);
            try {
              const ids = [...selectedIds].map((id) => Number(id)).filter((n) => n > 0);
              const payload = await fboSuppliesApi.openPurchaseCalcSession(ids);
              const sid = payload?.session?.id ?? payload?.id;
              if (!sid) throw new Error('Не удалось открыть расчёт закупки');
              navigate(`/stock-levels/fbo-supplies/purchase-calc?session=${sid}`, {
                state: { supplyIds: ids },
              });
            } catch (e) {
              setErr(e.response?.data?.message || e.message || 'Не удалось открыть расчёт закупки');
            } finally {
              setCalcLoading(false);
            }
          }}
        >
          {calcLoading ? '…' : `Рассчитать закупку${selectedIds.size ? ` (${selectedIds.size})` : ''}`}
        </Button>
      </div>

      {openCalcSessions.length > 0 ? (
        <div className="fbo-packing-hint" style={{ marginBottom: 12 }}>
          <strong>Активные расчёты закупки:</strong>{' '}
          {openCalcSessions.map((s) => (
            <button
              key={s.id}
              type="button"
              className="btn btn-link btn-sm p-0 me-2"
              onClick={() => navigate(`/stock-levels/fbo-supplies/purchase-calc?session=${s.id}`)}
            >
              №{s.id} ({Array.isArray(s.supplyIds) ? s.supplyIds.length : '—'} поставок)
            </button>
          ))}
        </div>
      ) : null}

      {err && <div className="alert alert-danger">{err}</div>}

      {loading ? (
        <p>Загрузка…</p>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm table-hover">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    checked={list.length > 0 && list.every((r) => selectedIds.has(String(r.id)))}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedIds(new Set(list.map((r) => String(r.id))));
                      } else {
                        setSelectedIds(new Set());
                      }
                    }}
                    title="Выбрать все"
                  />
                </th>
                <th>№</th>
                <th>Номер отгрузки</th>
                <th>Маркетплейс</th>
                <th>Дата готовности</th>
                <th>Склад МП</th>
                <th>Кластер размещения</th>
                <th>Комментарий</th>
                <th>Организация</th>
                <th>Кол-во, шт.</th>
                <th>Статус</th>
                <th>Создана</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {!list.length && (
                <tr>
                  <td colSpan={13} className="text-center muted">
                    Нет поставок. Загрузите из Excel или с маркетплейса.
                  </td>
                </tr>
              )}
              {list.map((row) => {
                const sid = String(row.id);
                const checked = selectedIds.has(sid);
                return (
                <tr
                  key={row.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/stock-levels/fbo-supplies/${row.id}`)}
                >
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(sid)) next.delete(sid);
                          else next.add(sid);
                          return next;
                        });
                      }}
                    />
                  </td>
                  <td>{row.id}</td>
                  <td>{row.externalShipmentNumber}</td>
                  <td>{getMarketplaceLabel(row.marketplace)}</td>
                  <td>{fmtDate(row.readyAt)}</td>
                  <td>{row.marketplaceWarehouseName || '—'}</td>
                  <td>{row.placementCluster || '—'}</td>
                  <td className="fbo-supply-note-cell" title={row.note || ''}>
                    {row.note
                      ? row.note.length > 48
                        ? `${row.note.slice(0, 48)}…`
                        : row.note
                      : '—'}
                  </td>
                  <td>{row.organizationName || '—'}</td>
                  <td>
                    <div className="fbo-supply-qty-with-reserve">
                      <span className="fbo-supply-qty-with-reserve__qty">{row.itemCount ?? '—'}</span>
                      <FboSupplyReserveBreakdown
                        inline
                        reserveDisabled={row.deductStock === false}
                        reservedFromStock={
                          row.reservedFromStockTotal ?? row.reserved_from_stock_total
                        }
                        reservedFromIncoming={
                          row.reservedFromIncomingTotal ?? row.reserved_from_incoming_total
                        }
                      />
                    </div>
                  </td>
                  <td>
                    <span className="badge bg-light text-dark">{getFboSupplyStatusLabel(row.status)}</span>
                  </td>
                  <td>{fmtDt(row.createdAt)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      disabled={deletingId === row.id}
                      onClick={(e) => handleDeleteSupply(row.id, e)}
                    >
                      {deletingId === row.id ? '…' : 'Удалить'}
                    </Button>
                  </td>
                </tr>
              );
              })}
            </tbody>
          </table>
        </div>
      )}

      <FboSupplyImportModal
        open={!!importMode}
        mode={importMode}
        onClose={() => setImportMode(null)}
        onImported={(result) => {
          load();
          const created = result?.created;
          if (importMode === 'excel' && created?.length === 1 && created[0]?.id) {
            navigate(`/stock-levels/fbo-supplies/${created[0].id}`);
          }
        }}
      />
    </div>
  );
}
