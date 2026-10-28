import React, { useCallback, useEffect, useState } from 'react';
import adsApi from '../../services/ads.api';
import './Ads.css';

const MP_OPTIONS = [
  { value: '', label: 'Все МП' },
  { value: 'ozon', label: 'Ozon' },
  { value: 'wildberries', label: 'Wildberries' },
  { value: 'yandex', label: 'Яндекс.Маркет' },
];

function fmtMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
}

function fmtPct(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Number(n).toFixed(2)}%`;
}

export function AdsDashboard() {
  const [marketplace, setMarketplace] = useState('');
  const [days, setDays] = useState(14);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adsApi.getDashboard({
        marketplace: marketplace || undefined,
        days,
      });
      setData(res?.data || null);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [marketplace, days]);

  useEffect(() => {
    load();
  }, [load]);

  const onSync = async () => {
    setSyncing(true);
    setError(null);
    try {
      await adsApi.sync({
        marketplace: marketplace || undefined,
        days,
      });
      await load();
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Ошибка синхронизации');
    } finally {
      setSyncing(false);
    }
  };

  const totals = data?.totals || {};

  return (
    <div>
      <div className="ads-toolbar">
        <label>
          <span className="ads-muted">Маркетплейс</span>
          <br />
          <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)}>
            {MP_OPTIONS.map((o) => (
              <option key={o.value || 'all'} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="ads-muted">Дней</span>
          <br />
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-primary" onClick={onSync} disabled={syncing}>
          {syncing ? 'Синхронизация…' : 'Синхронизировать'}
        </button>
        <button type="button" className="btn btn-light" onClick={load} disabled={loading}>
          Обновить
        </button>
      </div>

      {error && <div className="ads-muted" style={{ color: 'var(--error, #ef4444)' }}>{error}</div>}
      {loading && <div className="ads-muted">Загрузка…</div>}

      {!loading && data && (
        <>
          <div className="ads-kpi-row">
            <div className="ads-kpi">
              <div className="ads-kpi__label">Расход</div>
              <div className="ads-kpi__value">{fmtMoney(totals.spend)} ₽</div>
            </div>
            <div className="ads-kpi">
              <div className="ads-kpi__label">Выручка (реклама)</div>
              <div className="ads-kpi__value">{fmtMoney(totals.revenue)} ₽</div>
            </div>
            <div className="ads-kpi">
              <div className="ads-kpi__label">ДРР</div>
              <div className="ads-kpi__value">{fmtPct(totals.drrPercent)}</div>
            </div>
            <div className="ads-kpi">
              <div className="ads-kpi__label">SKU / в рекламе</div>
              <div className="ads-kpi__value">
                {totals.skus || 0} / {totals.activeSkus || 0}
              </div>
            </div>
          </div>

          {(data.byMarketplace || []).length > 0 && (
            <div className="ads-table-wrap" style={{ marginTop: 12 }}>
              <table className="ads-table">
                <thead>
                  <tr>
                    <th>МП</th>
                    <th>SKU</th>
                    <th>Активных</th>
                    <th>Расход</th>
                    <th>Выручка</th>
                    <th>ДРР</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byMarketplace.map((r) => (
                    <tr key={r.marketplace}>
                      <td>{r.marketplace}</td>
                      <td>{r.skus}</td>
                      <td>{r.activeSkus}</td>
                      <td>{fmtMoney(r.spend)}</td>
                      <td>{fmtMoney(r.revenue)}</td>
                      <td>{fmtPct(r.drrPercent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3 style={{ marginTop: 20, marginBottom: 8 }}>SKU</h3>
          <div className="ads-table-wrap">
            <table className="ads-table">
              <thead>
                <tr>
                  <th>МП</th>
                  <th>SKU</th>
                  <th>Товар</th>
                  <th>Расход</th>
                  <th>Выручка</th>
                  <th>ДРР</th>
                  <th>Клики</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {(data.skus || []).length === 0 ? (
                  <tr>
                    <td colSpan={8} className="ads-muted">
                      Нет данных. Настройте ключи рекламы в Интеграциях и нажмите «Синхронизировать».
                    </td>
                  </tr>
                ) : (
                  data.skus.map((r) => (
                    <tr key={`${r.marketplace}:${r.skuKey}`}>
                      <td>{r.marketplace}</td>
                      <td>{r.skuKey}</td>
                      <td>{r.productName || r.erpSku || '—'}</td>
                      <td>{fmtMoney(r.spend)}</td>
                      <td>{fmtMoney(r.revenue)}</td>
                      <td>{fmtPct(r.drrPercent)}</td>
                      <td>{r.clicks || 0}</td>
                      <td>
                        {r.inActiveCampaign === true ? (
                          <span className="ads-badge ads-badge--ok">в рекламе</span>
                        ) : r.inActiveCampaign === false ? (
                          <span className="ads-badge">выкл</span>
                        ) : (
                          <span className="ads-badge">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export default AdsDashboard;
