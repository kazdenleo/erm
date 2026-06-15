/**
 * Подпись резерва: с наличия / с пути.
 */

import React from 'react';

export function FboSupplyReserveBreakdown({
  reservedFromStock = 0,
  reservedFromIncoming = 0,
  inline = false,
}) {
  const stock = Number(reservedFromStock) || 0;
  const incoming = Number(reservedFromIncoming) || 0;
  if (stock <= 0 && incoming <= 0) return null;

  const parts = [];
  if (stock > 0) {
    parts.push(
      <span key="stock" className="fbo-reserve-breakdown__part" title="Зарезервировано с наличия">
        нал: {stock}
      </span>
    );
  }
  if (incoming > 0) {
    parts.push(
      <span key="incoming" className="fbo-reserve-breakdown__part" title="Зарезервировано с пути">
        путь: {incoming}
      </span>
    );
  }

  return (
    <span
      className={['fbo-reserve-breakdown', inline ? 'fbo-reserve-breakdown--inline' : '']
        .filter(Boolean)
        .join(' ')}
    >
      {parts}
    </span>
  );
}
