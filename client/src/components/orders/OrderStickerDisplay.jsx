import React from 'react';
import {
  orderStickerCellValue,
  shouldEmphasizeStickerSuffix,
  splitStickerEmphasis,
} from '../../utils/orderStickerDisplay';

function WbStickerNumber({ text, className = '' }) {
  const parts = splitStickerEmphasis(text);
  if (!parts) return <span className={className}>—</span>;
  if (!parts.prefix) {
    return (
      <span className={`order-sticker-suffix ${className}`.trim()}>{parts.suffix}</span>
    );
  }
  return (
    <span className={`order-sticker-value ${className}`.trim()}>
      <span className="order-sticker-prefix">{parts.prefix}</span>
      {' '}
      <span className="order-sticker-suffix">{parts.suffix}</span>
    </span>
  );
}

/**
 * Стикер заказа: для WB последние 4 цифры полужирные; для Ozon/ЯМ — номер заказа как есть.
 */
export function OrderStickerDisplay({
  order,
  groupOrders = null,
  className = '',
  emphasize = null,
}) {
  const value = orderStickerCellValue(order, { groupOrders });
  if (value === '—') return <span className={className}>—</span>;

  const wbEmphasis = emphasize ?? shouldEmphasizeStickerSuffix(order);
  if (!wbEmphasis) {
    return <span className={className}>{value}</span>;
  }

  const stickers = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <span className={`order-sticker-display ${className}`.trim()}>
      {stickers.map((sticker, index) => (
        <React.Fragment key={`${sticker}-${index}`}>
          {index > 0 ? ', ' : null}
          <WbStickerNumber text={sticker} />
        </React.Fragment>
      ))}
    </span>
  );
}
