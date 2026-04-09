/**
 * Изображения товара из JSON (поле images): первая картинка в списке = основная для превью.
 */

export function parseProductImages(images) {
  if (!images) return [];
  if (Array.isArray(images)) return images;
  if (typeof images === 'string') {
    try {
      const p = JSON.parse(images);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * URL основного изображения для миниатюры в списке.
 * @param {Record<string, unknown>|null|undefined} product
 * @returns {string} пустая строка, если нет
 */
export function getPrimaryProductImageUrl(product) {
  const list = parseProductImages(product?.images);
  if (list.length === 0) return '';

  const withUrl = (img) => {
    if (!img || typeof img !== 'object') return '';
    const raw = img.url ?? img.src ?? img.link ?? '';
    return typeof raw === 'string' ? raw.trim() : '';
  };

  const primary = list.find(
    (img) => img && (img.primary === true || img.is_main === true) && withUrl(img)
  );
  const chosen = primary || list.find((img) => withUrl(img));
  const t = chosen ? withUrl(chosen) : '';
  if (!t) return '';
  if (t.startsWith('http://') || t.startsWith('https://') || t.startsWith('data:')) return t;
  if (t.startsWith('/')) return t;
  return `/${t.replace(/^\//, '')}`;
}
