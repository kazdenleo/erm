import React, { useCallback, useEffect, useState } from 'react';
import adsApi from '../../services/ads.api';
import './Ads.css';

const MP_OPTIONS = [
  { value: '', label: 'Все МП' },
  { value: 'ozon', label: 'Ozon' },
  { value: 'wildberries', label: 'Wildberries' },
  { value: 'yandex', label: 'Яндекс.Маркет' },
];

export function AdsCampaigns() {
  const [marketplace, setMarketplace] = useState('');
  const [list, setList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [bidDrafts, setBidDrafts] = useState({});
  const [budgetDraft, setBudgetDraft] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adsApi.listCampaigns({
        marketplace: marketplace || undefined,
      });
      setList(res?.data || []);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Ошибка');
    } finally {
      setLoading(false);
    }
  }, [marketplace]);

  useEffect(() => {
    load();
  }, [load]);

  const openCampaign = async (id) => {
    setBusy(true);
    setError(null);
    try {
      const res = await adsApi.getCampaign(id);
      setSelected(res?.data || null);
      setBudgetDraft(
        res?.data?.dailyBudget != null ? String(res.data.dailyBudget) : ''
      );
      const drafts = {};
      for (const p of res?.data?.products || []) {
        drafts[p.id] = p.bid != null ? String(p.bid) : '';
      }
      setBidDrafts(drafts);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  const patchStatus = async (status) => {
    if (!selected?.id) return;
    setBusy(true);
    setError(null);
    try {
      await adsApi.patchCampaign(selected.id, { status });
      await openCampaign(selected.id);
      await load();
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  const saveBudget = async () => {
    if (!selected?.id) return;
    setBusy(true);
    setError(null);
    try {
      await adsApi.patchCampaign(selected.id, { dailyBudget: Number(budgetDraft) });
      await openCampaign(selected.id);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  const saveBid = async (productId) => {
    if (!selected?.id) return;
    setBusy(true);
    setError(null);
    try {
      await adsApi.patchCampaignProduct(selected.id, productId, {
        bid: Number(bidDrafts[productId]),
      });
      await openCampaign(selected.id);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="ads-toolbar">
        <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)}>
          {MP_OPTIONS.map((o) => (
            <option key={o.value || 'all'} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-light" onClick={load} disabled={loading}>
          Обновить
        </button>
      </div>

      {error && (
        <div className="ads-muted" style={{ color: 'var(--error, #ef4444)' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) minmax(320px, 1.2fr)', gap: 16 }}>
        <div className="ads-table-wrap">
          <table className="ads-table">
            <thead>
              <tr>
                <th>МП</th>
                <th>Название</th>
                <th>Статус</th>
                <th>Товары</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} className="ads-muted">
                    Загрузка…
                  </td>
                </tr>
              ) : list.length === 0 ? (
                <tr>
                  <td colSpan={4} className="ads-muted">
                    Кампаний нет — сначала синхронизируйте на дашборде
                  </td>
                </tr>
              ) : (
                list.map((c) => (
                  <tr
                    key={c.id}
                    style={{ cursor: 'pointer', background: selected?.id === c.id ? 'rgba(59,130,246,0.08)' : undefined }}
                    onClick={() => openCampaign(c.id)}
                  >
                    <td>{c.marketplace}</td>
                    <td>{c.name || c.externalId}</td>
                    <td>{c.status || '—'}</td>
                    <td>{c.productsCount}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div>
          {!selected ? (
            <div className="ads-muted">Выберите кампанию</div>
          ) : (
            <>
              <h3 style={{ marginTop: 0 }}>
                {selected.name || selected.externalId}{' '}
                <span className="ads-badge">{selected.marketplace}</span>
              </h3>
              <div className="ads-muted">
                ID: {selected.externalId} · статус: {selected.status || '—'} · тип:{' '}
                {selected.campaignType || '—'}
              </div>
              <div className="ads-actions" style={{ margin: '10px 0' }}>
                <button
                  type="button"
                  className="btn btn-warning"
                  disabled={busy}
                  onClick={() => patchStatus('pause')}
                >
                  Пауза
                </button>
                <button
                  type="button"
                  className="btn btn-success"
                  disabled={busy}
                  onClick={() => patchStatus('resume')}
                >
                  Старт
                </button>
              </div>
              <div className="ads-form-row">
                <label>
                  Дневной бюджет
                  <input
                    value={budgetDraft}
                    onChange={(e) => setBudgetDraft(e.target.value)}
                    type="number"
                  />
                </label>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={saveBudget}>
                  Сохранить бюджет
                </button>
              </div>

              <div className="ads-table-wrap">
                <table className="ads-table">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>ДРР</th>
                      <th>Ставка</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(selected.products || []).length === 0 ? (
                      <tr>
                        <td colSpan={4} className="ads-muted">
                          Нет товаров в кампании
                        </td>
                      </tr>
                    ) : (
                      selected.products.map((p) => (
                        <tr key={p.id}>
                          <td>{p.skuKey}</td>
                          <td>
                            {p.drrPercent != null ? `${Number(p.drrPercent).toFixed(2)}%` : '—'}
                          </td>
                          <td>
                            <input
                              style={{ width: 90 }}
                              value={bidDrafts[p.id] ?? ''}
                              onChange={(e) =>
                                setBidDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                              }
                              type="number"
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-sm btn-light"
                              disabled={busy}
                              onClick={() => saveBid(p.id)}
                            >
                              OK
                            </button>
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
      </div>
    </div>
  );
}

export default AdsCampaigns;
