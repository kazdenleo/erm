/**
 * Иконка QR-кода для ссылки на этикетку заказа (FBS).
 * Используется на страницах «Заказы» и «Сборка» вместо слова «Этикетка».
 */
import React from 'react';

export function OrderLabelIcon({ size = 20, className, title = 'Этикетка заказа (QR)' }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <title>{title}</title>
      <rect x="3" y="3" width="5" height="5" rx="1" />
      <rect x="16" y="3" width="5" height="5" rx="1" />
      <rect x="3" y="16" width="5" height="5" rx="1" />
      <rect x="16" y="16" width="5" height="5" rx="1" />
      <rect x="18" y="18" width="2" height="2" fill="currentColor" stroke="none" />
    </svg>
  );
}
