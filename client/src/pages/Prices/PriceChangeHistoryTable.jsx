import React from 'react';

export function formatHistoryMoney(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return `${Math.round(Number(v))} ₽`;
}

function moneyChanged(before, after) {
  if (before == null && after == null) return false;
  if (before == null || after == null) return true;
  return Math.round(Number(before)) !== Math.round(Number(after));
}

export function formatHistoryDelta(before, after) {
  if (!moneyChanged(before, after)) return '—';
  if (before == null) return `→ ${formatHistoryMoney(after)}`;
  if (after == null) return `${formatHistoryMoney(before)} → —`;
  const sign = Number(after) > Number(before) ? '+' : '';
  const d = Math.round(Number(after) - Number(before));
  return `${formatHistoryMoney(before)} → ${formatHistoryMoney(after)} (${sign}${d} ₽)`;
}

export function formatHistoryWhen(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(iso);
  }
}

function displayReason(reason) {
  const raw = String(reason || '').trim();
  if (!raw) return '—';
  const cleaned = raw
    .replace(/\s*:?\s*без изменения\s*(\([^)]*\))?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[:—–-]\s*$/g, '')
    .trim();
  return cleaned || '—';
}

export function PriceChangeHistoryTable({
  items = [],
  loading = false,
  error = null,
  emptyText = 'Пока нет изменений цен за выбранный период.',
  hideProductColumn = false,
  onProductClick,
}) {
  const visible = (Array.isArray(items) ? items : []).filter((row) => {
    return (
      moneyChanged(row.minPriceBefore, row.minPriceAfter) ||
      moneyChanged(row.sellingPriceBefore, row.sellingPriceAfter)
    );
  });

  if (loading && !items.length) {
    return <div className="loading">Загрузка истории…</div>;
  }

  return (
    <div className="price-history-table-wrap">
      {error ? (
        <div className="error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      ) : null}
      {!visible.length ? (
        <p className="text-muted price-history-empty">{emptyText}</p>
      ) : (
        <table className="price-history-table">
          <thead>
            <tr>
              <th>Когда</th>
              {hideProductColumn ? null : <th>Товар</th>}
              <th>МП</th>
              <th>Минимум</th>
              <th>Факт. цена</th>
              <th>Основание</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const sellChanged = moneyChanged(row.sellingPriceBefore, row.sellingPriceAfter);
              const minChanged = moneyChanged(row.minPriceBefore, row.minPriceAfter);
              const grounds = (Array.isArray(row.grounds) ? row.grounds : []).filter(
                (line) => !/без изменения|цену не меняли/i.test(String(line || ''))
              );
              return (
                <tr key={row.id} className="changed">
                  <td className="nowrap">{formatHistoryWhen(row.createdAt)}</td>
                  {hideProductColumn ? null : (
                    <td>
                      {onProductClick && row.productId ? (
                        <button
                          type="button"
                          className="price-history-product-btn"
                          onClick={() => onProductClick(row)}
                          title="Показать историю этого товара"
                        >
                          <div className="sku">{row.productSku || `#${row.productId}`}</div>
                          <div className="name muted">{row.productName || '—'}</div>
                        </button>
                      ) : (
                        <>
                          <div className="sku">{row.productSku || `#${row.productId}`}</div>
                          <div className="name muted">{row.productName || '—'}</div>
                        </>
                      )}
                    </td>
                  )}
                  <td className="nowrap">{row.marketplaceLabel || row.marketplace}</td>
                  <td className={`nowrap${minChanged ? ' price-history-delta-changed' : ''}`}>
                    {formatHistoryDelta(row.minPriceBefore, row.minPriceAfter)}
                  </td>
                  <td className={`nowrap${sellChanged ? ' price-history-delta-changed' : ''}`}>
                    {formatHistoryDelta(row.sellingPriceBefore, row.sellingPriceAfter)}
                  </td>
                  <td className="reason">
                    <div className="price-history-reason-title">
                      {displayReason(row.reason)}
                      {row.sourceLabel ? (
                        <span className="price-history-source">{row.sourceLabel}</span>
                      ) : null}
                    </div>
                    {grounds.length ? (
                      <ul className="price-history-grounds">
                        {grounds.map((line, idx) => (
                          <li key={`${idx}-${line}`}>{line}</li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
