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

function CategoryNav({ categories, categoryId, onCategory }) {
  if (!categories?.length || !onCategory) return null;
  const total = categories.reduce((s, c) => s + (c.count || 0), 0);
  const withImages = categories.filter((c) => c.imageUrl && String(c.id) !== 'none');
  return (
    <>
      {withImages.length ? (
        <div className="sf-cat-tiles" aria-label="Категории с изображениями">
          {withImages.map((c) => {
            const id = String(c.id);
            return (
              <button
                key={`tile-${id}`}
                type="button"
                className={`sf-cat-tile${categoryId === id ? ' is-active' : ''}`}
                onClick={() => onCategory(id)}
              >
                <span className="sf-cat-tile-media">
                  <img src={c.imageUrl} alt="" loading="lazy" />
                </span>
                <span className="sf-cat-tile-body">
                  <strong>{c.name}</strong>
                  <span>{c.count} тов.</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="sf-cats" role="tablist" aria-label="Категории">
        <button
          type="button"
          role="tab"
          className={`sf-cat${categoryId ? '' : ' is-active'}`}
          aria-selected={!categoryId}
          onClick={() => onCategory('')}
        >
          Все <span>{total}</span>
        </button>
        {categories.map((c) => {
          const id = String(c.id);
          return (
            <button
              key={id}
              type="button"
              role="tab"
              className={`sf-cat${categoryId === id ? ' is-active' : ''}`}
              aria-selected={categoryId === id}
              onClick={() => onCategory(id)}
            >
              {c.imageUrl ? (
                <img className="sf-cat-thumb" src={c.imageUrl} alt="" loading="lazy" />
              ) : null}
              {c.name} <span>{c.count}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function groupProductsByCategory(products) {
  const groups = new Map();
  for (const p of products || []) {
    const key =
      p.categoryId != null
        ? `c:${p.categoryId}`
        : 'none';
    const title = p.categoryName || (key === 'none' ? 'Без категории' : 'Категория');
    if (!groups.has(key)) groups.set(key, { key, title, items: [] });
    groups.get(key).items.push(p);
  }
  return [...groups.values()];
}

function CatalogProducts({
  products,
  categories,
  categoryId,
  slug,
  base,
  onCartChange,
  compact,
  groupWhenAll = true,
}) {
  const list = products || [];
  if (!list.length) return <div className="sf-empty">Пока нет товаров</div>;

  const shouldGroup = groupWhenAll && !categoryId && (categories || []).length > 1;
  if (!shouldGroup) {
    return (
      <div className={`sf-grid${compact ? ' is-compact' : ''}`}>
        {list.map((p) => (
          <ProductCard key={p.id} p={p} slug={slug} base={base} onCartChange={onCartChange} />
        ))}
      </div>
    );
  }

  return (
    <div className="sf-cat-groups">
      {groupProductsByCategory(list).map((g) => (
        <section key={g.key} className="sf-cat-group">
          <div className="sf-cat-group-head">
            <h3 className="sf-cat-group-title">{g.title}</h3>
            <span className="sf-section-meta">{g.items.length} тов.</span>
          </div>
          <div className={`sf-grid${compact ? ' is-compact' : ''}`}>
            {g.items.map((p) => (
              <ProductCard key={p.id} p={p} slug={slug} base={base} onCartChange={onCartChange} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function CatalogBlock({
  title,
  anchor,
  products,
  categories,
  categoryId,
  q,
  onSearch,
  onCategory,
  slug,
  base,
  onCartChange,
  loading,
  countLabel,
  compact,
}) {
  return (
    <section className="sf-section" id={anchor || 'catalog'}>
      <div className="sf-section-head">
        <h2 className="sf-section-title">{title || 'Каталог'}</h2>
        <div className="sf-section-meta">{countLabel}</div>
      </div>
      <CategoryNav categories={categories} categoryId={categoryId} onCategory={onCategory} />
      <div className="sf-toolbar">
        <input
          value={q}
          placeholder="Поиск по названию или артикулу"
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>
      {loading ? <div className="sf-muted">Загрузка…</div> : null}
      {!loading ? (
        <CatalogProducts
          products={products}
          categories={categories}
          categoryId={categoryId}
          slug={slug}
          base={base}
          onCartChange={onCartChange}
          compact={compact}
        />
      ) : null}
    </section>
  );
}

export function StorefrontBlocks({
  store,
  slug,
  base,
  products,
  categories = [],
  categoryId = '',
  q,
  onSearch,
  onCategory,
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
        <CatalogBlock
          title="Каталог"
          products={products}
          categories={categories}
          categoryId={categoryId}
          q={q}
          onSearch={onSearch}
          onCategory={onCategory}
          slug={slug}
          base={base}
          onCartChange={onCartChange}
          loading={loading}
          countLabel={countLabel}
        />
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
            <CatalogBlock
              key={b.id}
              title={props.title || 'Каталог'}
              anchor={props.anchor || 'catalog'}
              products={list}
              categories={categories}
              categoryId={categoryId}
              q={q}
              onSearch={onSearch}
              onCategory={onCategory}
              slug={slug}
              base={base}
              onCartChange={onCartChange}
              loading={loading}
              countLabel={countLabel}
              compact={compact}
            />
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
