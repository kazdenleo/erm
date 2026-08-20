import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import './ImageLightbox.css';

/**
 * Полноэкранный просмотр картинки. Клик по фону, Escape или крестик — закрыть.
 */
export function ImageLightbox({ urls, index = 0, onClose, onIndexChange, alt = '' }) {
  const list = (Array.isArray(urls) ? urls : []).map((u) => String(u || '').trim()).filter(Boolean);
  const safeIndex = list.length ? Math.min(Math.max(0, Number(index) || 0), list.length - 1) : 0;
  const src = list[safeIndex] || '';

  useEffect(() => {
    if (!src) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        onClose?.();
        return;
      }
      if (e.key === 'ArrowLeft' && list.length > 1) {
        e.preventDefault();
        e.stopPropagation();
        onIndexChange?.((safeIndex - 1 + list.length) % list.length);
        return;
      }
      if (e.key === 'ArrowRight' && list.length > 1) {
        e.preventDefault();
        e.stopPropagation();
        onIndexChange?.((safeIndex + 1) % list.length);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey, true);
    };
  }, [src, list.length, safeIndex, onClose, onIndexChange]);

  if (!src || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр изображения"
      onClick={onClose}
    >
      <button
        type="button"
        className="image-lightbox__close"
        aria-label="Закрыть"
        onClick={(e) => {
          e.stopPropagation();
          onClose?.();
        }}
      >
        ×
      </button>
      {list.length > 1 ? (
        <button
          type="button"
          className="image-lightbox__nav image-lightbox__nav--prev"
          aria-label="Предыдущее фото"
          onClick={(e) => {
            e.stopPropagation();
            onIndexChange?.((safeIndex - 1 + list.length) % list.length);
          }}
        >
          ‹
        </button>
      ) : null}
      <img
        className="image-lightbox__img"
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
      />
      {list.length > 1 ? (
        <button
          type="button"
          className="image-lightbox__nav image-lightbox__nav--next"
          aria-label="Следующее фото"
          onClick={(e) => {
            e.stopPropagation();
            onIndexChange?.((safeIndex + 1) % list.length);
          }}
        >
          ›
        </button>
      ) : null}
      {list.length > 1 ? (
        <div className="image-lightbox__counter">
          {safeIndex + 1} / {list.length}
        </div>
      ) : null}
    </div>,
    document.body
  );
}
