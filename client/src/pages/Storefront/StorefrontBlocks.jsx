import React from 'react';
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

function ProductCard({ p, slug, base, density, onCartChange }) {
  return (
    <Link to={productPath(base, slug, p.id)} className={`sf-card${density === 'list' ? ' is-list' : ''}`}>
      {p.imageUrl ? <img className="sf-card-img" src={p.imageUrl} alt="" /> : <div className="sf-card-img" />}
      <div className="sf-card-body">
        <div className="sf-card-name">{p.name}</div>
        <span className={`sf-badge${p.inStock ? '' : ' out'}`}>
          {p.inStock ? 'В наличии' : 'Нет в наличии'}
        </span>
        <div className="sf-card-price">{money(p.price)}</div>
        <button
          type="button"
          className="sf-btn sf-btn-primary"
          style={{ marginTop: 8 }}
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

  if (!blocks.length) {
    return (
      <>
        <section className="sf-hero">
          <h1>{store?.name || 'Каталог'}</h1>
          <p>{store?.tagline || 'Товары в наличии'}</p>
        </section>
        <div className="sf-toolbar">
          <input value={q} placeholder="Поиск" onChange={(e) => onSearch(e.target.value)} />
        </div>
        {loading ? <div className="sf-muted">Загрузка…</div> : null}
        <div className="sf-grid">
          {(products || []).map((p) => (
            <ProductCard key={p.id} p={p} slug={slug} base={base} onCartChange={onCartChange} />
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      {blocks.map((b) => {
        const props = b.props || {};
        if (b.type === 'hero') {
          const title = props.title || store?.name || 'Каталог';
          const subtitle = props.subtitle || store?.tagline || '';
          return (
            <section
              key={b.id}
              className={`sf-hero${props.compact ? ' is-compact' : ''}`}
            >
              <h1>{title}</h1>
              {subtitle ? <p>{subtitle}</p> : null}
              {props.showCta !== false ? (
                <a className="sf-btn sf-btn-primary" href={props.ctaHref || '#catalog'} style={{ marginTop: 12 }}>
                  {props.ctaLabel || 'Смотреть каталог'}
                </a>
              ) : null}
            </section>
          );
        }
        if (b.type === 'banner' && props.imageUrl) {
          const inner = (
            <img src={props.imageUrl} alt={props.alt || ''} className="sf-banner-img" />
          );
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
          const density = props.density === 'list' ? 'list' : 'grid';
          const limit = props.limit != null ? Number(props.limit) : null;
          let list = products || [];
          if (Number.isFinite(limit) && limit > 0) list = list.slice(0, limit);
          return (
            <section key={b.id} className="sf-section" id={props.anchor || 'catalog'}>
              {props.title ? <h2 className="sf-section-title">{props.title}</h2> : null}
              <div className="sf-toolbar">
                <input value={q} placeholder="Поиск" onChange={(e) => onSearch(e.target.value)} />
              </div>
              {loading ? <div className="sf-muted">Загрузка…</div> : null}
              {!loading && !list.length ? <div className="sf-muted">Пока нет товаров</div> : null}
              <div className={`sf-grid${density === 'list' ? ' is-list' : ''}`}>
                {list.map((p) => (
                  <ProductCard
                    key={p.id}
                    p={p}
                    slug={slug}
                    base={base}
                    density={density}
                    onCartChange={onCartChange}
                  />
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
