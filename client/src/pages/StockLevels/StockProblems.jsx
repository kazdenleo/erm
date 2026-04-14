/**
 * Stock Problems (orders without coverage)
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { stockProblemsApi } from '../../services/stockProblems.api';
import { Button } from '../../components/common/Button/Button';

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

function normalizeMarketplaceForUrl(mp) {
  const m = String(mp || '').toLowerCase();
  if (m === 'wb') return 'wildberries';
  if (m === 'ym' || m === 'yandexmarket') return 'yandex';
  return m;
}

export function StockProblems() {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [rows, setRows] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [flagLoading, setFlagLoading] = useState(false);
  const [flagMsg, setFlagMsg] = useState(null);

  const reload = async () => {
    setLoading(true);
    setErr(null);
    setFlagMsg(null);
    try {
      const data = await stockProblemsApi.getProblemOrders({ limit: 200 });
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось загрузить проблемы остатков');
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const totalUncovered = useMemo(() => {
    return rows.reduce((sum, r) => sum + (Number(r.uncovered_quantity) || 0), 0);
  }, [rows]);

  return (
    <div className="card">
      <h2 className="title">⚠️ Проблемы с остатком</h2>
      <p className="subtitle">
        Заказы, чей резерв не покрывается доступностью \(actual + incoming\). Расчёт FIFO по времени резерва.
      </p>

      {err && <p className="error">{err}</p>}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <Button variant="secondary" onClick={reload} disabled={loading}>
          {loading ? '...' : 'Обновить'}
        </Button>
        <Button
          onClick={async () => {
            setFlagLoading(true);
            setErr(null);
            setFlagMsg(null);
            try {
              const res = await stockProblemsApi.refreshFlags();
              setFlagMsg(`Флаги обновлены: ${res.updated ?? 0} (проблемных: ${res.totalProblemOrders ?? 0})`);
              await reload();
            } catch (e) {
              setErr(e.response?.data?.message || e.message || 'Не удалось обновить флаги');
            } finally {
              setFlagLoading(false);
            }
          }}
          disabled={flagLoading}
        >
          {flagLoading ? '...' : 'Пересчитать и пометить заказы'}
        </Button>
        <span className="muted" style={{ alignSelf: 'center' }}>
          Заказов: {rows.length} · непокрыто единиц: {totalUncovered}
        </span>
      </div>
      {flagMsg && <p className="muted">{flagMsg}</p>}

      {loading ? (
        <div className="loading">Загрузка…</div>
      ) : rows.length === 0 ? (
        <p className="muted">Проблемных заказов не найдено.</p>
      ) : (
        <div className="warehouse-ops-receipts-list-wrap">
          <table className="warehouse-ops-receipt-list-table warehouse-ops-receipt-list-table--documents table">
            <thead>
              <tr>
                <th>Маркетплейс</th>
                <th>Заказ</th>
                <th>Статус</th>
                <th>Непокрыто</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const mpUrl = normalizeMarketplaceForUrl(r.marketplace);
                const oid = r.order_id;
                const expanded = expandedId === r.id;
                return (
                  <React.Fragment key={r.id}>
                    <tr
                      className="stock-levels-row-clickable"
                      onClick={() => setExpandedId(expanded ? null : r.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === 'Enter' && setExpandedId(expanded ? null : r.id)}
                    >
                      <td>{r.marketplace}</td>
                      <td>
                        {oid ? (
                          <Link className="stock-levels-history-link" to={`/orders/${mpUrl}/${encodeURIComponent(oid)}`}>
                            {oid}
                          </Link>
                        ) : (
                          `#${r.id}`
                        )}
                      </td>
                      <td>{r.status || '—'}</td>
                      <td className="stock-change-minus">-{r.uncovered_quantity}</td>
                      <td>
                        <span className="muted">{expanded ? 'Свернуть' : 'Подробнее'}</span>
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={5}>
                          {Array.isArray(r.lines) && r.lines.length > 0 ? (
                            <div style={{ marginTop: 6 }}>
                              <div className="muted" style={{ marginBottom: 6 }}>
                                Строки (непокрытая часть резерва):
                              </div>
                              <table className="warehouse-ops-receipt-list-table table">
                                <thead>
                                  <tr>
                                    <th>Товар (productId)</th>
                                    <th>Непокрыто</th>
                                    <th>Резерв</th>
                                    <th>Время резерва</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.lines.map((l, idx) => (
                                    <tr key={`${r.id}-${idx}`}>
                                      <td>{l.productId}</td>
                                      <td className="stock-change-minus">-{l.uncovered}</td>
                                      <td>{l.reserved}</td>
                                      <td>{fmtDt(l.reservedAt)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <p className="muted">Нет деталей строк.</p>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

