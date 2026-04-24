import React, { useEffect, useMemo, useState } from 'react';
import { marketplaceInventoryApi } from '../../services/marketplaceInventory.api.js';
import './MarketplaceInventorySummary.css';

function fmtRub(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n));
}

function fmtQty(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n));
}

function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

export function MarketplaceInventorySummary({ visible }) {
  const [mpInv, setMpInv] = useState(null);
  const [comparisonNote, setComparisonNote] = useState('');
  const [mpApiDiagnostics, setMpApiDiagnostics] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!visible) {
      setMpInv(null);
      setComparisonNote('');
      setMpApiDiagnostics(null);
      return;
    }
    marketplaceInventoryApi
      .getSummary()
      .then((payload) => {
        if (!cancelled) {
          setMpInv(rowsFromPayload(payload));
          setComparisonNote(typeof payload?.comparisonNote === 'string' ? payload.comparisonNote : '');
        }
      })
      .catch(() => {
        if (!cancelled) setMpInv([]);
      });
    const t = setInterval(() => {
      marketplaceInventoryApi
        .getSummary()
        .then((payload) => {
          if (!cancelled) {
            setMpInv(rowsFromPayload(payload));
            setComparisonNote(typeof payload?.comparisonNote === 'string' ? payload.comparisonNote : '');
          }
        })
        .catch(() => {});
    }, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [visible]);

  const mpInvByMp = useMemo(() => {
    const list = Array.isArray(mpInv) ? mpInv : [];
    const map = new Map();
    for (const it of list) {
      const mp = String(it?.marketplace || '').toLowerCase();
      if (mp) map.set(mp, it);
    }
    return map;
  }, [mpInv]);

  const tableRows = useMemo(() => {
    const defs = [
      { mp: 'ozon', label: 'Ozon', icon: '🟠' },
      { mp: 'wildberries', label: 'Wildberries', icon: '🟣' },
      { mp: 'yandex', label: 'Яндекс Маркет', icon: '🔴' },
    ];
    const pick = (row, state) => {
      const totals = Array.isArray(row?.totals) ? row.totals : [];
      const costs = Array.isArray(row?.costs) ? row.costs : [];
      const t = totals.find((x) => String(x?.state || '').toLowerCase() === state);
      const c = costs.find((x) => String(x?.state || '').toLowerCase() === state);
      const erm = row?.ermOrdersInDelivery;
      const apiQty = Number(t?.qty ?? 0) || 0;
      const matchedQtyForCost = Number(c?.qty ?? 0) || 0;
      return {
        // qty — все строки снапшота по API; matchedQtyForCost — только строки, попавшие в JOIN с product_skus
        qty: apiQty,
        matchedQtyForCost,
        cost: Number(c?.costSum ?? 0) || 0,
        matchedProducts: Number(c?.matchedProducts ?? 0) || 0,
        ermInDeliveryQty: state === 'to_customer' && erm ? Number(erm.qty ?? 0) || 0 : null,
      };
    };
    return defs.map((d) => {
      const row = mpInvByMp.get(d.mp);
      const w = pick(row, 'mp_warehouse');
      const t = pick(row, 'to_customer');
      const r = pick(row, 'returning');
      return {
        ...d,
        w,
        t,
        r,
        snapshotAt: row?.snapshot?.created_at
          ? new Date(row.snapshot.created_at).toLocaleString('ru-RU')
          : null,
      };
    });
  }, [mpInvByMp]);

  const handleRefresh = async () => {
    if (!visible || refreshing) return;
    setRefreshing(true);
    try {
      const payload = await marketplaceInventoryApi.runNow();
      setMpInv(rowsFromPayload(payload));
      setComparisonNote(typeof payload?.comparisonNote === 'string' ? payload.comparisonNote : '');
      setMpApiDiagnostics(
        payload?.mpApiDiagnostics && typeof payload.mpApiDiagnostics === 'object' ? payload.mpApiDiagnostics : null
      );
    } catch {
      // ignore
    } finally {
      setRefreshing(false);
    }
  };

  if (!visible) return null;

  const hasAnySnapshot = tableRows.some(
    (p) => p.w?.qty || p.t?.qty || p.r?.qty || p.w?.cost || p.t?.cost || p.r?.cost
  );

  const cell = (b, { showErmTransit } = {}) => {
    const apiQty = Number(b?.qty ?? 0) || 0;
    const catQty = Number(b?.matchedQtyForCost ?? 0) || 0;
    const cost = Number(b?.cost ?? 0) || 0;
    const partialCatalog = apiQty > 0 && catQty < apiQty;
    const noneCatalog = apiQty > 0 && catQty === 0;
    const noCostInCatalog = catQty > 0 && cost === 0;
    return (
      <div className="mp-inv-cell">
        <div className="mp-inv-cell__row">
          <span className="text-muted">шт</span>
          <span className="mp-inv-cell__num">{fmtQty(apiQty)}</span>
        </div>
        <div className="mp-inv-cell__row">
          <span className="text-muted">₽</span>
          <span className="mp-inv-cell__num">{fmtRub(cost)}</span>
        </div>
        {catQty > 0 && cost > 0 ? (
          <div className="text-muted small mt-1" title="Только по штукам, вошедшим в расчёт себестоимости">
            ≈{fmtRub(Math.round(cost / catQty))} за шт по каталогу
          </div>
        ) : null}
        {noneCatalog ? (
          <div className="small text-warning mt-1">
            Сумма в ₽ не считается: ни одна из {fmtQty(apiQty)}&nbsp;шт не сопоставилась с полем артикула WB/Ozon в
            карточке товара (или формат артикула другой: nmId, chrtId, артикул продавца).
          </div>
        ) : null}
        {partialCatalog ? (
          <div className="small text-warning mt-1">
            ₽ занижены: себестоимость посчитана только по {fmtQty(catQty)}&nbsp;шт из {fmtQty(apiQty)} по API — остальные
            строки не нашли товар в каталоге по SKU или у сопоставленных товаров cost=0.
          </div>
        ) : null}
        {!partialCatalog && !noneCatalog && noCostInCatalog ? (
          <div className="small text-warning mt-1">
            Сопоставлено {fmtQty(catQty)}&nbsp;шт, но в карточках не задана себестоимость (cost).
          </div>
        ) : null}
        {showErmTransit && b?.ermInDeliveryQty != null ? (
          <div className="mp-inv-cell__sub text-muted small mt-1">в ERM «В доставке»: {fmtQty(b.ermInDeliveryQty)} шт</div>
        ) : null}
      </div>
    );
  };

  return (
    <div
      className="card mb-0 mp-inv-block"
      title="Штуки — по API маркетплейса в снапшоте. Рубли — только по позициям, сопоставленным с карточкой (SKU МП и себестоимость); если цифры расходятся, см. жёлтое пояснение под ячейкой."
    >
      <div className="card-header d-flex flex-wrap align-items-center justify-content-between gap-2">
        <div className="card-header-title mb-0 d-flex align-items-center flex-wrap gap-2">
          <i className="header-icon pe-7s-box2 icon-gradient bg-mean-fruit me-1" />
          Остатки маркетплейсов
        </div>
        <button
          type="button"
          className="btn btn-sm btn-wide btn-shadow btn-secondary"
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          title="Создать новый снапшот по API маркетплейсов"
          aria-label="Обновить остатки маркетплейсов сейчас"
        >
          {refreshing ? 'Загрузка…' : '↻ Обновить'}
        </button>
      </div>
      <div className="card-body pt-0">
        <p className="text-muted small mb-2">
          <strong>Шт</strong> — сумма по ответу API (все строки снапшота). <strong>₽</strong> — сумма quantity×cost
          только там, где строка снапшота сопоставилась с полем артикула маркетплейса в карточке; если сопоставилось не
          всё, сумма в ₽ будет меньше ожидаемой — под ячейкой покажем, по скольким штам реально посчитали. Под «В пути к
          клиенту» дополнительно — заказы в ERM «В доставке».
        </p>
        {comparisonNote ? (
          <p className="text-muted small mb-2 border-start border-3 ps-2" style={{ borderColor: 'rgba(0,0,0,.12)' }}>
            {comparisonNote}
          </p>
        ) : null}
        {hasAnySnapshot ? (
          <div className="table-responsive">
            <table className="align-middle mb-0 table table-hover table-sm mp-inv-table">
              <thead>
                <tr>
                  <th>Маркетплейс</th>
                  <th className="text-end">На складе МП</th>
                  <th className="text-end">В пути к клиенту</th>
                  <th className="text-end">От клиента (возвраты)</th>
                  <th className="text-nowrap d-none d-md-table-cell">Снапшот</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((p) => (
                  <tr key={p.mp}>
                    <td>
                      <span className="me-1" aria-hidden>
                        {p.icon}
                      </span>
                      <span className="fw-semibold">{p.label}</span>
                    </td>
                    <td className="text-end">{cell(p.w)}</td>
                    <td className="text-end">{cell(p.t, { showErmTransit: true })}</td>
                    <td className="text-end">{cell(p.r)}</td>
                    <td className="text-muted small d-none d-md-table-cell">
                      {p.snapshotAt ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-muted small py-3">Нет снапшотов. Нажмите «Обновить», чтобы создать первый.</div>
        )}
        {mpApiDiagnostics && Object.keys(mpApiDiagnostics).length > 0 ? (
          <details className="small text-muted mt-2">
            <summary className="cursor-pointer user-select-none">Срез ответа API маркетплейса (последнее «Обновить»)</summary>
            <pre className="mb-0 mt-2 p-2 bg-light rounded small overflow-auto" style={{ maxHeight: 320 }}>
              {JSON.stringify(mpApiDiagnostics, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

