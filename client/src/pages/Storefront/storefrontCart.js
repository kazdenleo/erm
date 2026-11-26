const key = (slug) => `erm_storefront_cart_${slug}`;

export function readCart(slug) {
  try {
    const raw = localStorage.getItem(key(slug));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeCart(slug, items) {
  localStorage.setItem(key(slug), JSON.stringify(items || []));
}

export function addToCart(slug, product, qty = 1) {
  const items = readCart(slug);
  const id = Number(product.id);
  const q = Math.max(1, Number(qty) || 1);
  const idx = items.findIndex((x) => Number(x.productId) === id);
  if (idx >= 0) {
    items[idx].quantity = Math.min(99, (items[idx].quantity || 0) + q);
  } else {
    items.push({
      productId: id,
      name: product.name,
      price: Number(product.price) || 0,
      imageUrl: product.imageUrl || null,
      quantity: q,
    });
  }
  writeCart(slug, items);
  return items;
}

export function setCartQty(slug, productId, quantity) {
  const q = Math.max(0, Math.min(99, Number(quantity) || 0));
  let items = readCart(slug);
  if (q <= 0) items = items.filter((x) => Number(x.productId) !== Number(productId));
  else {
    items = items.map((x) =>
      Number(x.productId) === Number(productId) ? { ...x, quantity: q } : x
    );
  }
  writeCart(slug, items);
  return items;
}

export function clearCart(slug) {
  writeCart(slug, []);
}

export function cartCount(items) {
  return (items || []).reduce((s, x) => s + (Number(x.quantity) || 0), 0);
}

export function cartTotal(items) {
  return (items || []).reduce(
    (s, x) => s + (Number(x.price) || 0) * (Number(x.quantity) || 0),
    0
  );
}
