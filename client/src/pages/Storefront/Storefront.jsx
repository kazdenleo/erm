/**
 * Публичная витрина /s/:slug — каталог, карточка, корзина, оформление.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { onlineStoreApi } from '../../services/onlineStore.api.js';
import {
  addToCart,
  cartCount,
  cartTotal,
  clearCart,
  readCart,
  setCartQty,
} from './storefrontCart.js';
import { ProductImage, StorefrontBlocks } from './StorefrontBlocks.jsx';
import './Storefront.css';

function money(n) {
  return `${Number(n || 0).toLocaleString('ru-RU')} ₽`;
}

/** /s/:slug на платформе; корень на своём домене. */
function storeBase(slug, hostMode) {
  return hostMode ? '' : `/s/${slug}`;
}

function sfPath(base, ...parts) {
  const rest = parts
    .filter((p) => p != null && p !== '')
    .map((p) => String(p).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  if (!base) return rest ? `/${rest}` : '/';
  return rest ? `${base}/${rest}` : base;
}

function Shell({ store, slug, base, cartItems, children }) {
  const count = cartCount(cartItems);
  const theme = store?.theme || {};
  const logo = theme.logoUrl || store?.logoUrl;
  const initial = String(store?.name || 'М').trim().charAt(0).toUpperCase() || 'М';
  return (
    <div
      className="sf-root"
      data-template={store?.templateCode || 'minimal'}
      data-font-heading={theme.fontHeading || 'system'}
      style={{
        '--sf-brand': theme.brandColor || store?.brandColor || '#0f766e',
        '--sf-accent': theme.accentColor || theme.brandColor || store?.brandColor || '#0f766e',
        '--sf-bg': theme.backgroundColor || undefined,
        '--sf-surface': theme.surfaceColor || undefined,
        '--sf-ink': theme.textColor || undefined,
        '--sf-muted': theme.mutedColor || undefined,
        '--sf-radius': theme.borderRadius != null ? `${theme.borderRadius}px` : undefined,
      }}
    >
      <div className="sf-shell">
        <header className="sf-header">
          <Link to={sfPath(base)} className="sf-brand">
            <span className="sf-brand-mark">
              {logo ? <img src={logo} alt="" /> : initial}
            </span>
            <span className="sf-brand-text">
              <span className="sf-brand-name">{store?.name || 'Магазин'}</span>
              {store?.tagline ? <span className="sf-brand-tag">{store.tagline}</span> : null}
            </span>
          </Link>
          <nav className="sf-nav">
            <a href="#catalog">Каталог</a>
            <Link to={sfPath(base, 'cart')}>
              Корзина
              {count ? <span className="sf-cart-count">{count}</span> : null}
            </Link>
          </nav>
        </header>
        {children}
        <footer className="sf-footer">
          <span>
            {[store?.phone, store?.email, store?.address].filter(Boolean).join(' · ') ||
              'Заказы обрабатываются продавцом'}
          </span>
          <span>{store?.name || 'Магазин'}</span>
        </footer>
      </div>
    </div>
  );
}

function CatalogView({ store, slug, base, onCartChange }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') || '';
  const categoryId = searchParams.get('categoryId') || '';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    onlineStoreApi
      .publicProducts(slug, { q, categoryId })
      .then((d) => {
        if (alive) {
          setData(d);
          setError('');
        }
      })
      .catch((e) => {
        if (alive) setError(e?.response?.data?.message || e?.message || 'Ошибка загрузки');
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [slug, q, categoryId]);

  const products = data?.products || [];
  const categories = data?.categories || [];
  const storeView = data?.store || store;

  const patchParams = (patch) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(patch).forEach(([key, value]) => {
      if (value == null || value === '') next.delete(key);
      else next.set(key, String(value));
    });
    setSearchParams(next);
  };

  return (
    <>
      {error ? <div className="sf-error">{error}</div> : null}
      <StorefrontBlocks
        store={storeView}
        slug={slug}
        base={base}
        products={products}
        categories={categories}
        categoryId={categoryId}
        q={q}
        loading={loading}
        onCartChange={onCartChange}
        onSearch={(v) => patchParams({ q: v })}
        onCategory={(id) => patchParams({ categoryId: id })}
      />
    </>
  );
}

function formatDateRu(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('ru-RU');
}

function ProductView({ slug, base, onCartChange }) {
  const { productId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [qty, setQty] = useState(1);

  useEffect(() => {
    let alive = true;
    onlineStoreApi
      .publicProduct(slug, productId)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e?.response?.data?.message || e?.message || 'Не найден'));
    return () => {
      alive = false;
    };
  }, [slug, productId]);

  const p = data?.product;
  const specs = Array.isArray(p?.specs) ? p.specs : [];
  const attributes = Array.isArray(p?.attributes) ? p.attributes : [];
  const certificates = Array.isArray(p?.certificates) ? p.certificates : [];

  return (
    <div className="sf-panel">
      {error ? <div className="sf-error">{error}</div> : null}
      {!p && !error ? <div className="sf-muted">Загрузка…</div> : null}
      {p ? (
        <>
          <div className="sf-pdp">
            <div className="sf-pdp-media">
              <ProductImage src={p.imageUrl} className="sf-pdp-img" />
            </div>
            <div>
              {p.categoryName ? <div className="sf-pdp-cat">{p.categoryName}</div> : null}
              <h1 className="sf-pdp-title">{p.name}</h1>
              {p.sku ? <div className="sf-muted">Артикул: {p.sku}</div> : null}
              <div className="sf-card-price sf-pdp-price">{money(p.price)}</div>
              <span className={`sf-badge${p.inStock ? '' : ' out'}`}>
                {p.inStock ? `В наличии: ${p.stock}` : 'Нет в наличии'}
              </span>
              <div className="sf-pdp-buy">
                <input
                  className="sf-qty"
                  type="number"
                  min={1}
                  max={Math.max(1, p.stock || 1)}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
                />
                <button
                  type="button"
                  className="sf-btn sf-btn-primary"
                  disabled={!p.inStock}
                  onClick={() => {
                    onCartChange(addToCart(slug, p, qty));
                    navigate(sfPath(base, 'cart'));
                  }}
                >
                  В корзину
                </button>
              </div>
            </div>
          </div>

          {p.description ? (
            <section className="sf-pdp-block">
              <h2 className="sf-pdp-h">Описание</h2>
              <p className="sf-pdp-text">{p.description}</p>
            </section>
          ) : null}

          {specs.length ? (
            <section className="sf-pdp-block">
              <h2 className="sf-pdp-h">Основные характеристики</h2>
              <dl className="sf-specs">
                {specs.map((s) => (
                  <div key={s.name} className="sf-specs-row">
                    <dt>{s.name}</dt>
                    <dd>{s.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}

          {attributes.length ? (
            <section className="sf-pdp-block">
              <h2 className="sf-pdp-h">Атрибуты</h2>
              <dl className="sf-specs">
                {attributes.map((a) => (
                  <div key={a.id || a.name} className="sf-specs-row">
                    <dt>{a.name}</dt>
                    <dd>{a.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}

          {certificates.length ? (
            <section className="sf-pdp-block">
              <h2 className="sf-pdp-h">Сертификаты</h2>
              <ul className="sf-certs">
                {certificates.map((c) => (
                  <li key={c.id} className={`sf-cert${c.expired ? ' is-expired' : ''}`}>
                    <div className="sf-cert-main">
                      <strong>
                        {c.documentType}
                        {c.number ? ` № ${c.number}` : ''}
                      </strong>
                      <div className="sf-muted">
                        {[
                          c.validFrom ? `с ${formatDateRu(c.validFrom)}` : null,
                          c.validTo ? `по ${formatDateRu(c.validTo)}` : null,
                          c.expired ? 'срок истёк' : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                    {c.fileUrl ? (
                      <a className="sf-btn" href={c.fileUrl} target="_blank" rel="noreferrer">
                        Открыть
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function CartView({ slug, base, items, onCartChange }) {
  const navigate = useNavigate();
  const total = cartTotal(items);
  return (
    <div className="sf-panel">
      <h1 style={{ marginTop: 0, fontSize: '1.35rem' }}>Корзина</h1>
      {!items.length ? <div className="sf-muted">Корзина пуста</div> : null}
      {items.map((it) => (
        <div key={it.productId} className="sf-line-row">
          <div>
            <strong>{it.name}</strong>
            <div className="sf-muted">{money(it.price)}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="sf-qty"
              type="number"
              min={0}
              value={it.quantity}
              onChange={(e) => onCartChange(setCartQty(slug, it.productId, e.target.value))}
            />
            <strong>{money(it.price * it.quantity)}</strong>
          </div>
        </div>
      ))}
      {items.length ? (
        <>
          <div className="sf-line-row" style={{ borderBottom: 'none' }}>
            <strong>Итого</strong>
            <strong>{money(total)}</strong>
          </div>
          <button
            type="button"
            className="sf-btn sf-btn-primary"
            onClick={() => navigate(sfPath(base, 'checkout'))}
          >
            Оформить заказ
          </button>
        </>
      ) : (
        <Link className="sf-btn" to={sfPath(base)}>
          В каталог
        </Link>
      )}
    </div>
  );
}

function CheckoutView({ store, slug, base, items, onCartChange }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    customerName: '',
    customerPhone: '',
    customerEmail: '',
    customerAddress: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!items.length) {
    return (
      <div className="sf-panel">
        <div className="sf-muted">Корзина пуста</div>
        <Link className="sf-btn" to={sfPath(base)}>
          В каталог
        </Link>
      </div>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const result = await onlineStoreApi.checkout(slug, {
        ...form,
        items: items.map((it) => ({ productId: it.productId, quantity: it.quantity })),
      });
      clearCart(slug);
      onCartChange([]);
      navigate(sfPath(base, 'thanks'), { state: { result } });
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось оформить');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="sf-panel">
      <h1 style={{ marginTop: 0, fontSize: '1.35rem' }}>Оформление</h1>
      <p className="sf-muted">
        Итого {money(cartTotal(items))}
        {store?.phone ? ` · вопросы: ${store.phone}` : ''}
      </p>
      {error ? <div className="sf-error">{error}</div> : null}
      <form className="sf-form" onSubmit={submit}>
        <label>
          Имя *
          <input
            required
            value={form.customerName}
            onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))}
          />
        </label>
        <label>
          Телефон *
          <input
            required
            value={form.customerPhone}
            onChange={(e) => setForm((f) => ({ ...f, customerPhone: e.target.value }))}
          />
        </label>
        <label>
          Email
          <input
            type="email"
            value={form.customerEmail}
            onChange={(e) => setForm((f) => ({ ...f, customerEmail: e.target.value }))}
          />
        </label>
        <label>
          Адрес доставки / самовывоз
          <textarea
            rows={2}
            value={form.customerAddress}
            onChange={(e) => setForm((f) => ({ ...f, customerAddress: e.target.value }))}
          />
        </label>
        <button type="submit" className="sf-btn sf-btn-primary" disabled={submitting}>
          {submitting ? 'Отправляем…' : 'Подтвердить заказ'}
        </button>
      </form>
    </div>
  );
}

function ThanksView({ base }) {
  return (
    <div className="sf-panel">
      <h1 style={{ marginTop: 0 }}>Заказ принят</h1>
      <p className="sf-muted">Мы получили заявку и свяжемся с вами для подтверждения.</p>
      <Link className="sf-btn sf-btn-primary" to={sfPath(base)}>
        Вернуться в каталог
      </Link>
    </div>
  );
}

function StorefrontShellRoutes({ slug, store, error, cartItems, onCartChange, hostMode = false }) {
  const base = storeBase(slug, hostMode);

  if (error && !store) {
    return (
      <div className="sf-root">
        <div className="sf-shell">
          <div className="sf-panel">
            <div className="sf-error">{error}</div>
            {!hostMode ? (
              <Link className="sf-btn" to="/">
                На главную
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (!slug) {
    return (
      <div className="sf-root">
        <div className="sf-shell">
          <div className="sf-panel">
            <div className="text-muted">Загрузка витрины…</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Shell store={store} slug={slug} base={base} cartItems={cartItems}>
      <Routes>
        <Route
          index
          element={<CatalogView store={store} slug={slug} base={base} onCartChange={onCartChange} />}
        />
        <Route
          path="p/:productId"
          element={<ProductView slug={slug} base={base} onCartChange={onCartChange} />}
        />
        <Route
          path="cart"
          element={<CartView slug={slug} base={base} items={cartItems} onCartChange={onCartChange} />}
        />
        <Route
          path="checkout"
          element={
            <CheckoutView
              store={store}
              slug={slug}
              base={base}
              items={cartItems}
              onCartChange={onCartChange}
            />
          }
        />
        <Route path="thanks" element={<ThanksView base={base} />} />
      </Routes>
    </Shell>
  );
}

export function Storefront() {
  const { slug } = useParams();
  const [store, setStore] = useState(null);
  const [error, setError] = useState('');
  const [cartItems, setCartItems] = useState(() => readCart(slug));

  useEffect(() => {
    setCartItems(readCart(slug));
  }, [slug]);

  useEffect(() => {
    let alive = true;
    onlineStoreApi
      .publicStore(slug)
      .then((d) => {
        if (alive) {
          setStore(d);
          setError('');
        }
      })
      .catch((e) => {
        if (alive) setError(e?.response?.data?.message || e?.message || 'Магазин не найден');
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  const onCartChange = useCallback((items) => setCartItems(items), []);

  return (
    <StorefrontShellRoutes
      slug={slug}
      store={store}
      error={error}
      cartItems={cartItems}
      onCartChange={onCartChange}
    />
  );
}

/** Витрина на своём домене: Host → slug, тот же UI что /s/:slug. */
export function StorefrontByHost() {
  const [slug, setSlug] = useState('');
  const [store, setStore] = useState(null);
  const [error, setError] = useState('');
  const [cartItems, setCartItems] = useState([]);

  useEffect(() => {
    let alive = true;
    const host =
      typeof window !== 'undefined' ? window.location.hostname : '';
    onlineStoreApi
      .publicByHost(host)
      .then((d) => {
        if (!alive) return;
        const nextSlug = d?.slug || '';
        setSlug(nextSlug);
        setStore(d);
        setError('');
        if (nextSlug) setCartItems(readCart(nextSlug));
      })
      .catch((e) => {
        if (alive) setError(e?.response?.data?.message || e?.message || 'Магазин не найден');
      });
    return () => {
      alive = false;
    };
  }, []);

  const onCartChange = useCallback((items) => setCartItems(items), []);

  return (
    <StorefrontShellRoutes
      slug={slug}
      store={store}
      error={error}
      cartItems={cartItems}
      onCartChange={onCartChange}
      hostMode
    />
  );
}

export default Storefront;
