/**
 * Клик для навигации / открытия карточек: не срабатывает при выделении текста для копирования
 * и при перетаскивании мыши (drag-select).
 */

/** @type {{ x: number, y: number } | null} */
let pointerDown = null;

export function installNavigationClickPointerTracking() {
  if (typeof document === 'undefined') return;
  if (document.documentElement.dataset.ermNavClickTrack === '1') return;
  document.documentElement.dataset.ermNavClickTrack = '1';

  document.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0) return;
      pointerDown = { x: e.clientX, y: e.clientY };
    },
    true
  );

  document.addEventListener(
    'click',
    () => {
      pointerDown = null;
    },
    true
  );
}

/**
 * @param {MouseEvent|import('react').MouseEvent} e
 * @param {{ ignoreClosest?: string }} [opts]
 */
export function shouldIgnoreNavigationClick(e, opts = {}) {
  if (!e) return false;
  if (e.defaultPrevented) return true;
  if (typeof e.button === 'number' && e.button !== 0) return true;

  const ignoreClosest =
    opts.ignoreClosest ||
    'input, textarea, select, label, [contenteditable="true"], [data-no-nav-click]';

  const target = e.target;
  if (target && typeof target.closest === 'function') {
    if (target.closest(ignoreClosest)) return true;
    if (target.closest('[data-nav-action], .product-actions, .orders-col-actions, .orders-col-checkbox')) {
      return true;
    }
  }

  const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
  if (sel && !sel.isCollapsed) {
    const text = String(sel.toString() || '').trim();
    if (text.length > 0) return true;
  }

  if (pointerDown) {
    const dx = e.clientX - pointerDown.x;
    const dy = e.clientY - pointerDown.y;
    if (Math.hypot(dx, dy) > 5) return true;
  }

  return false;
}

/**
 * @param {(e: MouseEvent) => void} handler
 * @param {{ ignoreClosest?: string }} [opts]
 */
export function onNavigationClick(handler, opts) {
  return (e) => {
    if (shouldIgnoreNavigationClick(e, opts)) return;
    handler(e);
  };
}
