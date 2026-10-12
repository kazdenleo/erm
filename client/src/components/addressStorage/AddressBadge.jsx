import React from 'react';
import './AddressStorage.shared.css';

/** Адрес ячейки рядом с товаром (сборка, сбор FBO). */
export function AddressBadge({ address, large = false, title = 'Адрес хранения' }) {
  if (!address) return null;
  return (
    <span className={`address-badge${large ? ' address-badge--lg' : ''}`} title={title}>
      📍 {address}
    </span>
  );
}
