/**
 * Подпись резерва: с наличия / с пути / не в резерве.
 */

import React from 'react';
import { formatFboReserveHoverTitle } from './fboSupplyItemReserve.js';

export function FboSupplyReserveBreakdown({
  reservedFromStock = 0,
  reservedFromIncoming = 0,
  unreserved = 0,
  planned = null,
  sourceOnHand = null,
  sourceIncoming = null,
  reserveDisabled = false,
  inline = false,
  showEmpty = false,
}) {
  const stock = Number(reservedFromStock) || 0;
  const incoming = Number(reservedFromIncoming) || 0;
  const gap = Math.max(0, Number(unreserved) || 0);
  const onHand = sourceOnHand != null ? Number(sourceOnHand) || 0 : null;
  const onPath = sourceIncoming != null ? Number(sourceIncoming) || 0 : null;

  if (reserveDisabled) {
    if (!showEmpty) return null;
    return (
      <span className="fbo-reserve-breakdown fbo-reserve-breakdown--disabled">
        <span
          className="fbo-reserve-breakdown__part fbo-reserve-breakdown__part--empty"
          title="Включите «Списать остатки при отгрузке», чтобы резервировать товар"
        >
          резерв выкл.
        </span>
      </span>
    );
  }

  if (stock <= 0 && incoming <= 0 && gap <= 0 && !showEmpty) return null;

  const parts = [];
  if (stock > 0) {
    parts.push(
      <span key="stock" className="fbo-reserve-breakdown__part" title="С наличия на складе списания остатков">
        нал: {stock}
      </span>
    );
  } else if (showEmpty) {
    const hint =
      onHand != null && onHand > 0
        ? `На складе списания ${onHand} шт., но не покрывает эту строку (занято заказами или более ранними поставками)`
        : 'Нет свободного наличия на складе списания остатков';
    parts.push(
      <span key="stock" className="fbo-reserve-breakdown__part fbo-reserve-breakdown__part--empty" title={hint}>
        нал: 0
      </span>
    );
  }

  if (incoming > 0) {
    parts.push(
      <span
        key="incoming"
        className="fbo-reserve-breakdown__part"
        title="Из открытых закупок на склад списания FBO"
      >
        путь: {incoming}
      </span>
    );
  } else if (showEmpty) {
    const hint =
      onPath != null && onPath > 0
        ? `В пути ${onPath} шт., но не выделено на эту строку`
        : 'Нет ожидаемых поступлений по этому товару';
    parts.push(
      <span
        key="incoming"
        className="fbo-reserve-breakdown__part fbo-reserve-breakdown__part--empty"
        title={hint}
      >
        путь: 0
      </span>
    );
  }

  if (gap > 0) {
    parts.push(
      <span
        key="gap"
        className="fbo-reserve-breakdown__part fbo-reserve-breakdown__part--gap"
        title="Количество в поставке без покрытия резервом (нал + путь)"
      >
        не рез: {gap}
      </span>
    );
  } else if (showEmpty) {
    parts.push(
      <span
        key="gap"
        className="fbo-reserve-breakdown__part fbo-reserve-breakdown__part--empty"
        title="Вся строка покрыта резервом с наличия или из пути"
      >
        не рез: 0
      </span>
    );
  }

  return (
    <span
      className={['fbo-reserve-breakdown', inline ? 'fbo-reserve-breakdown--inline' : '']
        .filter(Boolean)
        .join(' ')}
      title={formatFboReserveHoverTitle({
        stock,
        incoming,
        unreserved: gap,
        planned,
        reserveDisabled: false,
      })}
    >
      {parts}
    </span>
  );
}
