/**
 * Сверка привязки товаров к сертификату на маркетплейсе: сколько привязано и почему остальные — нет.
 */

import React, { useState } from 'react';

const OZON_PRODUCT_STATUS_LABELS = {
  approved: 'одобрено',
  awaiting_verification: 'на проверке',
  verification: 'на проверке',
  background_check: 'фоновая проверка',
  declined: 'отклонено',
  unknown: 'без статуса',
};

function ItemsList({ title, items, total, render }) {
  const [open, setOpen] = useState(false);
  if (!items?.length) return null;
  return (
    <div className="binding-report__list">
      <button type="button" className="binding-report__toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} {title} ({total ?? items.length})
      </button>
      {open ? (
        <ul>
          {items.map((it, idx) => (
            <li key={idx}>{render(it)}</li>
          ))}
          {(total ?? items.length) > items.length ? (
            <li className="muted">…и ещё {(total ?? items.length) - items.length}</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

export function CertificateBindingReport({ marketplace, report, error }) {
  const title = marketplace === 'ozon' ? 'Ozon' : 'Яндекс.Маркет';
  if (error) {
    return (
      <div className="binding-report binding-report--error">
        <strong>{title}:</strong> не удалось проверить привязку — {error}
      </div>
    );
  }
  if (!report) {
    return (
      <div className="binding-report">
        <strong>{title}:</strong> <span className="muted">документ ещё не отправлен</span>
      </div>
    );
  }
  const ok = report.missing_count === 0 && !(report.statuses?.declined > 0);
  const statuses = Object.entries(report.statuses || {})
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${OZON_PRODUCT_STATUS_LABELS[code] || code} — ${n}`);

  return (
    <div className={`binding-report${ok ? ' binding-report--ok' : ' binding-report--warn'}`}>
      <div>
        <strong>{title}:</strong> привязано {report.bound} из {report.expected} товаров
        {report.missing_count > 0 ? `, не привязано ${report.missing_count}` : ''}.
      </div>
      {statuses.length ? <div className="binding-report__statuses">Проверка товаров: {statuses.join(', ')}.</div> : null}
      {report.held_by_other_count > 0 ? (
        <div className="binding-report__hint">
          {report.held_by_other_count} товаров на Ozon привязаны к другому сертификату — Ozon держит товар
          только в одном сертификате. Их можно перепривязать.
        </div>
      ) : null}
      {report.not_on_marketplace_count > 0 ? (
        <div className="binding-report__hint">
          {report.not_on_marketplace_count} офферов нет на Маркете (не созданы или в архиве).
        </div>
      ) : null}
      <ItemsList
        title="Не привязаны"
        items={report.missing}
        total={report.missing_count}
        render={(it) => (
          <>
            <strong>{it.sku || it.offer_id || it.ozon_product_id}</strong>
            {it.ozon_product_id ? <span className="muted"> (Ozon {it.ozon_product_id})</span> : null} — {it.reason}
          </>
        )}
      />
      <ItemsList
        title="Ozon отклонил привязку"
        items={report.declined}
        total={report.statuses?.declined}
        render={(it) => (
          <>
            <strong>{it.sku || it.ozon_product_id}</strong>
            <span className="muted"> (Ozon {it.ozon_product_id})</span> — причина видна в кабинете Ozon
          </>
        )}
      />
    </div>
  );
}

export default CertificateBindingReport;
