import React from 'react';

/** Заголовок подраздела: как на странице «Закупка» (h2.title + p.subtitle). */
export function StockSectionHeader({ title, subtitle }) {
  if (!title) return null;
  return (
    <header className="stock-section-header">
      <h2 className="title">{title}</h2>
      {subtitle ? <p className="subtitle">{subtitle}</p> : null}
    </header>
  );
}