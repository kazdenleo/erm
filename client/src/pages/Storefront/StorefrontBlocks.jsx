import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { addToCart } from './storefrontCart.js';

function money(n) {
  return `${Number(n || 0).toLocaleString('ru-RU')} ₽`;
}

function productPath(base, slug, productId) {
  if (base) return `${base}/p/${productId}`;
  if (slug) return `/s/${slug}/p/${productId}`;
  return `/p/${productId}`;
}

function ImagePlaceholder({ label = 'Нет фото' }) {
  return (
    <div className="sf-card-ph" aria-hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="9" cy="10" r="1.6" />
        <path d="M4.5 16.5 9 12l3 2.5 3.5-4 4 6" />
      </svg>
      <span>{label}</span>
    </div>
  );
}

function ProductImage({ src, className = 'sf-card-img' }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <ImagePlaceholder />;
  return (
    <img
      className={className}
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function ProductCard({ p, slug, base, onCartChange }) {
  return (
    <Link to={productPath(base, slug, p.id)} className="sf-card">
      <div className="sf-card-media">
        <ProductImage src={p.imageUrl} />
      </div>
      <div className="sf-card-body">
        <div className="sf-card-name">{p.name}</div>
        <span className={`sf-badge${p.inStock ? '' : ' out'}`}>
          {p.inStock ? 'В наличии' : 'Нет в наличии'}
        </span>
        <div className="sf-card-price-row">
          <div className="sf-card-price">{money(p.price)}</div>
        </div>
        <button
          type="button"
          className="sf-btn sf-btn-primary"
          disabled={!p.inStock}
          onClick={(e) => {
            e.preventDefault();
            onCartChange(addToCart(slug, p, 1));
          }}
        >
          В корзину
        </button>
      </div>
    </Link>
  );
}

function HeroBlock({ store, title, subtitle, showCta, ctaLabel, ctaHref, compact }) {
  return (
    <section className={`sf-hero${compact ? ' is-compact' : ''}`}>
      {!compact ? <div className="sf-hero-kicker">Интернет-магазин</div> : null}
      <h1>{title || store?.name || 'Каталог'}</h1>
      {(subtitle || store?.tagline) ? <p>{subtitle || store?.tagline}</p> : null}
      {showCta !== false ? (
        <a className="sf-btn" href={ctaHref || '#catalog'}>
          {ctaLabel || 'Смотреть каталог'}
        </a>
      ) : null}
    </section>
  );
}

export function StorefrontBlocks({
  store,
  slug,
  base,
  products,
  q,
  onSearch,
  onCartChange,
  loading,
}) {
  const layout = store?.layout;
  const blocks = Array.isArray(layout?.blocks) ? layout.blocks.filter((b) => b?.enabled !== false) : [];
  const byId = new Map((products || []).map((p) => [p.id, p]));
  const countLabel = loading ? '…' : `${(products || []).length} тов.`;

  if (!blocks.length) {
    return (
      <>
        <HeroBlock store={store} title={store?.name} subtitle={store?.tagline} />
        <section className="sf-section" id="catalog">
          <div className="sf-section-head">
            <h2 className="sf-section-title">Каталог</h2>
            <div className="sf-section-meta">{countLabel}</div>
          </div>
          <div className="sf-toolbar">
            <input
              value={q}
              placeholder="Поиск по названию или артикулу"
              onChange={(e) => onSearch(e.target.value)}
            />
          </div>
          {loading ? <div className="sf-muted">Загрузка…</div> : null}
          {!loading && !(products || []).length ? (
            <div className="sf-empty">Пока нет товаров для показа</div>
          ) : (
            <div className="sf-grid">
              {(products || []).map((p) => (
                <ProductCard key={p.id} p={p} slug={slug} base={base} onCartChange={onCartChange} />
              ))}
            </div>
          )}
        </section>
      </>
    );
  }

  return (
    <>
      {blocks.map((b) => {
        const props = b.props || {};
        if (b.type === 'hero') {
          return (
            <HeroBlock
              key={b.id}
              store={store}
              title={props.title}
              subtitle={props.subtitle || store?.tagline}
              showCta={props.showCta !== false}
              ctaLabel={props.ctaLabel || 'Смотреть каталог'}
              ctaHref={props.ctaHref || '#catalog'}
            />
          );
        }
        if (b.type === 'banner' && props.imageUrl) {
          const inner = <img src={props.imageUrl} alt={props.alt || ''} className="sf-banner-img" />;
          return (
            <div key={b.id} className="sf-banner">
              {props.href ? (
                <a href={props.href} target="_blank" rel="noreferrer">
                  {inner}
                </a>
              ) : (
                inner
              )}
            </div>
          );
        }
        if (b.type === 'featured') {
          const ids = Array.isArray(props.productIds) ? props.productIds : [];
          const list = ids.map((id) => byId.get(Number(id))).filter(Boolean);
          if (!list.length) return null;
          return (
            <section key={b.id} className="sf-section">
              {props.title ? <h2 className="sf-section-title">{props.title}</h2> : null}
              <div className="sf-grid">
                {list.map((p) => (
                  <ProductCard key={p.id} p={p} slug={slug} base={base} onCartChange={onCartChange} />
                ))}
              </div>
            </section>
          );
        }
        if (b.type === 'catalog') {
          const compact = props.density === 'list';
          const limit = props.limit != null ? Number(props.limit) : null;
          let list = products || [];
          if (Number.isFinite(limit) && limit > 0) list = list.slice(0, limit);
          return (
            <section key={b.id} className="sf-section" id={props.anchor || 'catalog'}>
              <div className="sf-section-head">
                <h2 className="sf-section-title">{props.title || 'Каталог'}</h2>
                <div className="sf-section-meta">{countLabel}</div>
              </div>
              <div className="sf-toolbar">
                <input
                  value={q}
                  placeholder="Поиск по названию или артикулу"
                  onChange={(e) => onSearch(e.target.value)}
                />
              </div>
              {loading ? <div className="sf-muted">Загрузка…</div> : null}
              {!loading && !list.length ? <div className="sf-empty">Пока нет товаров</div> : null}
              <div className={`sf-grid${compact ? ' is-compact' : ''}`}>
                {list.map((p) => (
                  <ProductCard key={p.id} p={p} slug={slug} base={base} onCartChange={onCartChange} />
                ))}
              </div>
            </section>
          );
        }
        if (b.type === 'rich_text' && (props.title || props.body)) {
          return (
            <section key={b.id} className="sf-panel sf-section">
              {props.title ? <h2 className="sf-section-title">{props.title}</h2> : null}
              {props.body ? (
                <p className="sf-muted" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                  {props.body}
                </p>
              ) : null}
            </section>
          );
        }
        if (b.type === 'contacts') {
          const lines = [store?.phone, store?.email, store?.address].filter(Boolean);
          if (!lines.length) return null;
          return (
            <section key={b.id} className="sf-panel sf-section">
              <h2 className="sf-section-title">Контакты</h2>
              <p className="sf-muted" style={{ margin: 0 }}>
                {lines.join(' · ')}
              </p>
            </section>
          );
        }
        return null;
      })}
    </>
  );
}

export { ProductImage, ImagePlaceholder };
