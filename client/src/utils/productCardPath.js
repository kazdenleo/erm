/** URL карточки товара (отдельная страница, не модалка). */

export function productCardPath(productId, extra = {}) {
  if (productId == null || productId === '' || productId === 'new') {
    return '/products/new';
  }
  const id = encodeURIComponent(String(productId));
  const tab = extra.tab && extra.tab !== 'main' ? String(extra.tab).trim() : '';
  return tab ? `/products/${id}?tab=${encodeURIComponent(tab)}` : `/products/${id}`;
}

/** Старые ссылки `/products?open=:id` из уведомлений и задач. */
export function rewriteLegacyProductCardUrl(url) {
  const s = String(url || '').trim();
  if (!s) return s;
  try {
    const u = s.startsWith('/') ? new URL(s, 'http://local.invalid') : new URL(s);
    const path = u.pathname.replace(/\/$/, '') || '/';
    if (path !== '/products') return s;
    const open = u.searchParams.get('open');
    if (!open) return s;
    return productCardPath(open, { tab: u.searchParams.get('tab') });
  } catch {
    return s;
  }
}

export function shouldOpenProductCardInNewTab(e) {
  if (!e) return false;
  return Boolean(e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1);
}
