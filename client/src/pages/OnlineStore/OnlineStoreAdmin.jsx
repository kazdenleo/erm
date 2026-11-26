/**
 * Настройка интернет-магазина: шаблон, адрес, брендинг, товары, публикация.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageTitle } from '../../components/layout/PageTitle/PageTitle';
import { Button } from '../../components/common/Button/Button';
import { useAuth } from '../../context/AuthContext.jsx';
import { isProfilePrivateOrdersEnabled } from '../../utils/profileFlags.js';
import { onlineStoreApi } from '../../services/onlineStore.api.js';
import { productsApi } from '../../services/products.api.js';
import { getPrimaryProductImageUrl } from '../../utils/productImage.js';
import './OnlineStoreAdmin.css';

const TEMPLATES_FALLBACK = [
  { code: 'minimal', name: 'Минимал', blurb: 'Чистая витрина' },
  { code: 'showcase', name: 'Витрина', blurb: 'Герой + акцентные карточки' },
  { code: 'catalog', name: 'Каталог', blurb: 'Плотный список' },
];

const BLOCK_TYPES_FALLBACK = [
  { type: 'hero', name: 'Шапка / герой', blurb: 'Название, слоган и кнопка' },
  { type: 'banner', name: 'Баннер', blurb: 'Картинка с ссылкой' },
  { type: 'featured', name: 'Подборка товаров', blurb: 'Выбранные SKU с витрины' },
  { type: 'catalog', name: 'Каталог', blurb: 'Сетка или список товаров' },
  { type: 'rich_text', name: 'Текст', blurb: 'Произвольный текстовый блок' },
  { type: 'contacts', name: 'Контакты', blurb: 'Телефон, email, адрес магазина' },
];

const DEFAULT_THEME = {
  brandColor: '#0f766e',
  accentColor: '#0f766e',
  backgroundColor: '#f8fafc',
  surfaceColor: '#ffffff',
  textColor: '#0f172a',
  mutedColor: '#64748b',
  fontHeading: 'system',
  fontBody: 'system',
  borderRadius: 14,
  logoUrl: '',
};

function normalizeSlugInput(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function normalizeThemeState(raw, brandFallback = '#0f766e') {
  const t = raw && typeof raw === 'object' ? raw : {};
  const hex = (v, def) => (/^#[0-9a-fA-F]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : def);
  const radius = Number(t.borderRadius);
  return {
    brandColor: hex(t.brandColor, brandFallback || DEFAULT_THEME.brandColor),
    accentColor: hex(t.accentColor, hex(t.brandColor, brandFallback || DEFAULT_THEME.accentColor)),
    backgroundColor: hex(t.backgroundColor, DEFAULT_THEME.backgroundColor),
    surfaceColor: hex(t.surfaceColor, DEFAULT_THEME.surfaceColor),
    textColor: hex(t.textColor, DEFAULT_THEME.textColor),
    mutedColor: hex(t.mutedColor, DEFAULT_THEME.mutedColor),
    fontHeading: ['system', 'serif', 'display'].includes(t.fontHeading) ? t.fontHeading : 'system',
    fontBody: ['system', 'serif'].includes(t.fontBody) ? t.fontBody : 'system',
    borderRadius: Number.isFinite(radius) ? Math.min(24, Math.max(0, Math.round(radius))) : 14,
    logoUrl: t.logoUrl != null ? String(t.logoUrl) : '',
  };
}

function newBlockId(type) {
  return `${type}_${Math.random().toString(36).slice(2, 9)}`;
}

function defaultBlockProps(type) {
  switch (type) {
    case 'hero':
      return {
        title: '',
        subtitle: '',
        showCta: true,
        ctaLabel: 'Смотреть каталог',
        ctaHref: '#catalog',
        compact: false,
      };
    case 'banner':
      return { imageUrl: '', href: '', alt: '' };
    case 'featured':
      return { title: 'Подборка', productIds: [] };
    case 'catalog':
      return { title: 'Каталог', anchor: 'catalog', density: 'grid' };
    case 'rich_text':
      return { title: '', body: '' };
    case 'contacts':
      return {};
    default:
      return {};
  }
}

export function OnlineStoreAdmin() {
  const { profile } = useAuth();
  const privateOk = isProfilePrivateOrdersEnabled(profile);
  const warehouseId = profile?.manual_orders_warehouse_id ?? profile?.manualOrdersWarehouseId;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [okMsg, setOkMsg] = useState('');
  const [templates, setTemplates] = useState(TEMPLATES_FALLBACK);
  const [blockTypes, setBlockTypes] = useState(BLOCK_TYPES_FALLBACK);
  const [catalog, setCatalog] = useState([]);
  const [form, setForm] = useState({
    slug: '',
    name: '',
    templateCode: 'minimal',
    brandColor: '#0f766e',
    tagline: '',
    phone: '',
    email: '',
    address: '',
    published: false,
    productMode: 'all',
  });
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [search, setSearch] = useState('');
  const [editorEnabled, setEditorEnabled] = useState(false);
  const [theme, setTheme] = useState(() => normalizeThemeState(DEFAULT_THEME));
  const [layoutBlocks, setLayoutBlocks] = useState([]);
  const [addBlockType, setAddBlockType] = useState('banner');
  const [customDomainEnabled, setCustomDomainEnabled] = useState(false);
  const [customDomain, setCustomDomain] = useState('');
  const [domainMeta, setDomainMeta] = useState({
    status: 'none',
    error: '',
    dns: null,
  });
  const [attributeCategories, setAttributeCategories] = useState([]);
  const [attrByCategory, setAttrByCategory] = useState({});
  const [attrOpenId, setAttrOpenId] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [mine, prods] = await Promise.all([
        onlineStoreApi.getMine(),
        productsApi.getAll({ limit: 300, listView: 'stock' }),
      ]);
      const list = Array.isArray(prods?.data)
        ? prods.data
        : Array.isArray(prods?.items)
          ? prods.items
          : Array.isArray(prods)
            ? prods
            : [];
      setCatalog(list);
      if (Array.isArray(mine?.templates) && mine.templates.length) setTemplates(mine.templates);
      if (Array.isArray(mine?.blockTypes) && mine.blockTypes.length) setBlockTypes(mine.blockTypes);
      setEditorEnabled(!!mine?.editorEnabled);
      setCustomDomainEnabled(!!mine?.customDomainEnabled);
      setAttributeCategories(
        Array.isArray(mine?.attributeCategories) ? mine.attributeCategories : []
      );
      const s = mine?.store;
      if (s) {
        const nextTheme = normalizeThemeState(s.theme, s.brandColor || '#0f766e');
        setTheme(nextTheme);
        setForm({
          slug: s.slug || '',
          name: s.name || '',
          templateCode: s.templateCode || 'minimal',
          brandColor: nextTheme.brandColor,
          tagline: s.tagline || '',
          phone: s.phone || '',
          email: s.email || '',
          address: s.address || '',
          published: !!s.published,
          productMode: s.productMode || 'all',
        });
        setSelectedIds(new Set((mine.products || []).map((p) => Number(p.productId))));
        setLayoutBlocks(Array.isArray(s.layout?.blocks) ? s.layout.blocks : []);
        setCustomDomain(s.customDomain || '');
        setDomainMeta({
          status: s.customDomainStatus || 'none',
          error: s.customDomainError || '',
          dns: s.dns || null,
        });
        setAttrByCategory(
          s.attributeDisplay?.byCategory && typeof s.attributeDisplay.byCategory === 'object'
            ? { ...s.attributeDisplay.byCategory }
            : {}
        );
      } else {
        setForm((f) => ({
          ...f,
          name: profile?.name || 'Мой магазин',
          phone: profile?.contact_phone || '',
          email: profile?.contact_email || '',
        }));
        setTheme(normalizeThemeState(DEFAULT_THEME));
        setLayoutBlocks([]);
        setCustomDomain('');
        setDomainMeta({ status: 'none', error: '', dns: null });
        setAttrByCategory({});
      }
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить');
    } finally {
      setLoading(false);
    }
  }, [profile]);

  useEffect(() => {
    reload();
  }, [reload]);

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(
      (p) =>
        String(p.name || '')
          .toLowerCase()
          .includes(q) ||
        String(p.sku || '')
          .toLowerCase()
          .includes(q)
    );
  }, [catalog, search]);

  const publicUrl = form.slug
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/s/${form.slug}`
    : '';

  const setField = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (key === 'brandColor') {
      setTheme((t) => ({ ...t, brandColor: value, accentColor: t.accentColor || value }));
    }
  };

  const setThemeField = (key, value) => {
    setTheme((t) => {
      const next = { ...t, [key]: value };
      if (key === 'brandColor') {
        setForm((f) => ({ ...f, brandColor: value }));
      }
      return next;
    });
  };

  const blockLabel = (type) =>
    blockTypes.find((b) => b.type === type)?.name ||
    BLOCK_TYPES_FALLBACK.find((b) => b.type === type)?.name ||
    type;

  const updateBlockProps = (idx, patch) => {
    setLayoutBlocks((prev) =>
      prev.map((x, i) => (i === idx ? { ...x, props: { ...(x.props || {}), ...patch } } : x))
    );
  };

  const addLayoutBlock = () => {
    const type = String(addBlockType || '').trim();
    if (!BLOCK_TYPES_FALLBACK.some((b) => b.type === type)) return;
    setLayoutBlocks((prev) => [
      ...prev,
      { id: newBlockId(type), type, enabled: true, props: defaultBlockProps(type) },
    ]);
  };

  const removeLayoutBlock = (idx) => {
    setLayoutBlocks((prev) => {
      const target = prev[idx];
      if (target?.type === 'catalog') return prev;
      return prev.filter((_, i) => i !== idx);
    });
  };

  const toggleProduct = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const categoryAttrIds = (cat) => (cat?.attributes || []).map((a) => Number(a.id));

  const isAttrChecked = (catId, attrId) => {
    const key = String(catId);
    const selected = attrByCategory[key];
    if (selected == null) return true;
    return selected.map(Number).includes(Number(attrId));
  };

  const isAttrConfigured = (catId) =>
    Object.prototype.hasOwnProperty.call(attrByCategory, String(catId));

  const toggleCategoryAttr = (cat, attrId) => {
    const key = String(cat.id);
    const allIds = categoryAttrIds(cat);
    setAttrByCategory((prev) => {
      const current = prev[key] != null ? prev[key].map(Number) : [...allIds];
      const next = new Set(current);
      const id = Number(attrId);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, [key]: [...next] };
    });
  };

  const selectAllCategoryAttrs = (cat) => {
    setAttrByCategory((prev) => ({
      ...prev,
      [String(cat.id)]: categoryAttrIds(cat),
    }));
  };

  const clearCategoryAttrs = (cat) => {
    setAttrByCategory((prev) => ({
      ...prev,
      [String(cat.id)]: [],
    }));
  };

  const resetCategoryAttrs = (cat) => {
    setAttrByCategory((prev) => {
      const next = { ...prev };
      delete next[String(cat.id)];
      return next;
    });
  };

  const save = async ({ publish } = {}) => {
    setSaving(true);
    setError('');
    setOkMsg('');
    try {
      const body = {
        ...form,
        slug: normalizeSlugInput(form.slug),
        published: publish != null ? publish : form.published,
        products:
          form.productMode === 'selected'
            ? [...selectedIds].map((productId, i) => ({ productId, sortOrder: i }))
            : undefined,
        attributeDisplay: { byCategory: attrByCategory },
      };
      if (editorEnabled) {
        body.theme = {
          ...theme,
          brandColor: theme.brandColor || form.brandColor,
          logoUrl: String(theme.logoUrl || '').trim() || null,
        };
        body.logoUrl = String(theme.logoUrl || '').trim() || null;
        body.layout = { version: 1, blocks: layoutBlocks };
      }
      if (customDomainEnabled) {
        body.customDomain = String(customDomain || '').trim();
      }
      const data = await onlineStoreApi.saveMine(body);
      setEditorEnabled(!!data?.editorEnabled);
      setCustomDomainEnabled(!!data?.customDomainEnabled);
      setAttributeCategories(
        Array.isArray(data?.attributeCategories) ? data.attributeCategories : attributeCategories
      );
      const s = data?.store;
      if (s) {
        const nextTheme = normalizeThemeState(s.theme, s.brandColor || form.brandColor);
        setTheme(nextTheme);
        setForm((f) => ({
          ...f,
          slug: s.slug,
          name: s.name,
          templateCode: s.templateCode,
          brandColor: nextTheme.brandColor,
          tagline: s.tagline || '',
          phone: s.phone || '',
          email: s.email || '',
          address: s.address || '',
          published: !!s.published,
          productMode: s.productMode || 'all',
        }));
        setSelectedIds(new Set((data.products || []).map((p) => Number(p.productId))));
        setLayoutBlocks(Array.isArray(s.layout?.blocks) ? s.layout.blocks : []);
        setCustomDomain(s.customDomain || '');
        setDomainMeta({
          status: s.customDomainStatus || 'none',
          error: s.customDomainError || '',
          dns: s.dns || null,
        });
        setAttrByCategory(
          s.attributeDisplay?.byCategory && typeof s.attributeDisplay.byCategory === 'object'
            ? { ...s.attributeDisplay.byCategory }
            : {}
        );
      }
      setOkMsg(publish === true ? 'Магазин опубликован' : publish === false ? 'Снят с публикации' : 'Сохранено');
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="online-store-admin">
      <PageTitle
        iconClass="pe-7s-shopbag"
        iconBgClass="bg-happy-green"
        title="Интернет-магазин"
        subtitle="Витрина из вашего каталога: шаблон, адрес и заказ в частные заказы"
      />

      {!privateOk ? (
        <div className="alert alert-warning" role="alert">
          Интернет-магазин доступен только при включённых частных заказах. Включите их в{' '}
          <Link to="/settings">Настройки → Аккаунт</Link>. Частные заказы можно вести и без
          витрины.
        </div>
      ) : !warehouseId ? (
        <div className="alert alert-warning" role="alert">
          Укажите склад списания для частных заказов в <Link to="/settings">Настройки → Аккаунт</Link>
          — без него витрину опубликовать нельзя.
        </div>
      ) : null}

      {error ? (
        <div className="alert alert-danger py-2" role="alert">
          {error}
        </div>
      ) : null}
      {okMsg ? (
        <div className="alert alert-success py-2" role="alert">
          {okMsg}
        </div>
      ) : null}

      {loading ? (
        <div className="text-muted">Загрузка…</div>
      ) : (
        <div className="row g-3">
          <div className="col-lg-7">
            <div className="card online-store-card">
              <div className="card-body">
                <h3 className="h6 mb-3">Магазин</h3>
                <label className="online-store-label">
                  Название
                  <input
                    className="form-control"
                    value={form.name}
                    onChange={(e) => setField('name', e.target.value)}
                  />
                </label>
                <label className="online-store-label">
                  Адрес витрины
                  <div className="input-group">
                    <span className="input-group-text">/s/</span>
                    <input
                      className="form-control"
                      value={form.slug}
                      placeholder="my-shop"
                      onChange={(e) => setField('slug', normalizeSlugInput(e.target.value))}
                    />
                  </div>
                </label>
                {publicUrl ? (
                  <p className="small text-muted mb-3">
                    Ссылка:{' '}
                    <a href={publicUrl} target="_blank" rel="noreferrer">
                      {publicUrl}
                    </a>
                  </p>
                ) : null}
                <label className="online-store-label">
                  Слоган
                  <input
                    className="form-control"
                    value={form.tagline}
                    onChange={(e) => setField('tagline', e.target.value)}
                    placeholder="Доставка по городу, самовывоз"
                  />
                </label>
                <div className="row g-2">
                  <div className="col-md-4">
                    <label className="online-store-label">
                      Цвет
                      <input
                        type="color"
                        className="form-control form-control-color"
                        value={form.brandColor}
                        onChange={(e) => setField('brandColor', e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="col-md-4">
                    <label className="online-store-label">
                      Телефон
                      <input
                        className="form-control"
                        value={form.phone}
                        onChange={(e) => setField('phone', e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="col-md-4">
                    <label className="online-store-label">
                      Email
                      <input
                        className="form-control"
                        value={form.email}
                        onChange={(e) => setField('email', e.target.value)}
                      />
                    </label>
                  </div>
                </div>
                <label className="online-store-label">
                  Адрес / самовывоз
                  <input
                    className="form-control"
                    value={form.address}
                    onChange={(e) => setField('address', e.target.value)}
                  />
                </label>

                <h3 className="h6 mt-4 mb-2">Шаблон</h3>
                <div className="online-store-templates">
                  {templates.map((t) => (
                    <button
                      key={t.code}
                      type="button"
                      className={`online-store-template${
                        form.templateCode === t.code ? ' is-active' : ''
                      }`}
                      onClick={() => setField('templateCode', t.code)}
                    >
                      <strong>{t.name}</strong>
                      <span>{t.blurb}</span>
                    </button>
                  ))}
                </div>

                <h3 className="h6 mt-4 mb-2">Товары на витрине</h3>
                <div className="btn-group mb-2" role="group">
                  <button
                    type="button"
                    className={`btn btn-sm ${form.productMode === 'all' ? 'btn-primary' : 'btn-outline-secondary'}`}
                    onClick={() => setField('productMode', 'all')}
                  >
                    Весь каталог
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${
                      form.productMode === 'selected' ? 'btn-primary' : 'btn-outline-secondary'
                    }`}
                    onClick={() => setField('productMode', 'selected')}
                  >
                    Выбранные
                  </button>
                </div>

                {form.productMode === 'selected' ? (
                  <>
                    <input
                      className="form-control form-control-sm mb-2"
                      placeholder="Поиск по названию или SKU"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <div className="online-store-product-pick">
                      {filteredCatalog.map((p) => {
                        const id = Number(p.id);
                        const checked = selectedIds.has(id);
                        const img = getPrimaryProductImageUrl(p);
                        return (
                          <label key={id} className={`online-store-pick-row${checked ? ' is-on' : ''}`}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleProduct(id)}
                            />
                            {img ? (
                              <img src={img} alt="" className="online-store-pick-img" />
                            ) : (
                              <span className="online-store-pick-img is-empty" />
                            )}
                            <span className="online-store-pick-meta">
                              <strong>{p.name}</strong>
                              <span className="text-muted">
                                {p.sku || '—'} · {p.price != null ? `${p.price} ₽` : 'цена не задана'}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                      {!filteredCatalog.length ? (
                        <div className="text-muted small">Нет товаров для выбора</div>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <p className="small text-muted mb-0">
                    На витрине будут все товары профиля (до 500). Цена — из карточки товара.
                  </p>
                )}

                <h3 className="h6 mt-4 mb-2">Атрибуты на карточке товара</h3>
                <p className="small text-muted mb-2">
                  Для каждой категории отметьте, какие характеристики показывать покупателю. Пока
                  настройка не сохранена для категории — на витрине видны все атрибуты с значениями.
                </p>
                {attributeCategories.length ? (
                  <div className="online-store-attr-cats">
                    {attributeCategories.map((cat) => {
                      const open = attrOpenId === cat.id;
                      const attrs = cat.attributes || [];
                      const configured = isAttrConfigured(cat.id);
                      const selectedCount = configured
                        ? (attrByCategory[String(cat.id)] || []).length
                        : attrs.length;
                      return (
                        <div
                          key={cat.id}
                          className={`online-store-attr-cat${open ? ' is-open' : ''}${
                            configured ? ' is-configured' : ''
                          }`}
                        >
                          <button
                            type="button"
                            className="online-store-attr-cat-head"
                            onClick={() => setAttrOpenId(open ? null : cat.id)}
                          >
                            <span className="online-store-attr-cat-title">{cat.name}</span>
                            <span className="online-store-attr-cat-meta text-muted">
                              {attrs.length
                                ? configured
                                  ? `${selectedCount} из ${attrs.length}`
                                  : `все (${attrs.length})`
                                : 'нет атрибутов'}
                            </span>
                          </button>
                          {open ? (
                            <div className="online-store-attr-cat-body">
                              {!attrs.length ? (
                                <p className="small text-muted mb-0">
                                  К категории не привязаны атрибуты. Добавьте их в справочнике
                                  категорий.
                                </p>
                              ) : (
                                <>
                                  <div className="online-store-attr-cat-actions">
                                    <button
                                      type="button"
                                      className="btn btn-sm btn-outline-secondary"
                                      onClick={() => selectAllCategoryAttrs(cat)}
                                    >
                                      Все
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-sm btn-outline-secondary"
                                      onClick={() => clearCategoryAttrs(cat)}
                                    >
                                      Ничего
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-sm btn-outline-secondary"
                                      onClick={() => resetCategoryAttrs(cat)}
                                      title="Снова показывать все без отдельной настройки"
                                    >
                                      Сбросить
                                    </button>
                                  </div>
                                  <div className="online-store-attr-list">
                                    {attrs.map((attr) => (
                                      <label
                                        key={attr.id}
                                        className={`online-store-attr-row${
                                          isAttrChecked(cat.id, attr.id) ? ' is-on' : ''
                                        }`}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={isAttrChecked(cat.id, attr.id)}
                                          onChange={() => toggleCategoryAttr(cat, attr.id)}
                                        />
                                        <span>{attr.name}</span>
                                      </label>
                                    ))}
                                  </div>
                                </>
                              )}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="small text-muted mb-0">
                    Категорий пока нет — создайте их в каталоге, чтобы настроить показ атрибутов.
                  </p>
                )}

                <h3 className="h6 mt-4 mb-2">Дизайн и раскладка</h3>
                {editorEnabled ? (
                  <div className="online-store-editor">
                    <p className="small text-muted mb-3">
                      Тариф Про: цвета, шрифты, логотип и блоки витрины. Сохраните — изменения
                      сразу на публичной странице магазина.
                    </p>

                    <h4 className="h6 mb-2">Оформление</h4>
                    <div className="online-store-theme-grid">
                      <label className="online-store-label">
                        Бренд
                        <input
                          type="color"
                          className="form-control form-control-color"
                          value={theme.brandColor}
                          onChange={(e) => setThemeField('brandColor', e.target.value)}
                        />
                      </label>
                      <label className="online-store-label">
                        Акцент
                        <input
                          type="color"
                          className="form-control form-control-color"
                          value={theme.accentColor}
                          onChange={(e) => setThemeField('accentColor', e.target.value)}
                        />
                      </label>
                      <label className="online-store-label">
                        Фон
                        <input
                          type="color"
                          className="form-control form-control-color"
                          value={theme.backgroundColor}
                          onChange={(e) => setThemeField('backgroundColor', e.target.value)}
                        />
                      </label>
                      <label className="online-store-label">
                        Карточки
                        <input
                          type="color"
                          className="form-control form-control-color"
                          value={theme.surfaceColor}
                          onChange={(e) => setThemeField('surfaceColor', e.target.value)}
                        />
                      </label>
                      <label className="online-store-label">
                        Текст
                        <input
                          type="color"
                          className="form-control form-control-color"
                          value={theme.textColor}
                          onChange={(e) => setThemeField('textColor', e.target.value)}
                        />
                      </label>
                      <label className="online-store-label">
                        Приглушённый
                        <input
                          type="color"
                          className="form-control form-control-color"
                          value={theme.mutedColor}
                          onChange={(e) => setThemeField('mutedColor', e.target.value)}
                        />
                      </label>
                    </div>
                    <div className="row g-2 mb-3">
                      <div className="col-md-4">
                        <label className="online-store-label">
                          Шрифт заголовков
                          <select
                            className="form-select form-select-sm"
                            value={theme.fontHeading}
                            onChange={(e) => setThemeField('fontHeading', e.target.value)}
                          >
                            <option value="system">Без засечек</option>
                            <option value="serif">С засечками</option>
                            <option value="display">Акцидентный</option>
                          </select>
                        </label>
                      </div>
                      <div className="col-md-4">
                        <label className="online-store-label">
                          Шрифт текста
                          <select
                            className="form-select form-select-sm"
                            value={theme.fontBody}
                            onChange={(e) => setThemeField('fontBody', e.target.value)}
                          >
                            <option value="system">Без засечек</option>
                            <option value="serif">С засечками</option>
                          </select>
                        </label>
                      </div>
                      <div className="col-md-4">
                        <label className="online-store-label">
                          Скругление ({theme.borderRadius}px)
                          <input
                            type="range"
                            className="form-range"
                            min={0}
                            max={24}
                            value={theme.borderRadius}
                            onChange={(e) => setThemeField('borderRadius', Number(e.target.value))}
                          />
                        </label>
                      </div>
                    </div>
                    <label className="online-store-label">
                      Логотип (URL)
                      <input
                        className="form-control form-control-sm"
                        value={theme.logoUrl || ''}
                        placeholder="https://… или /uploads/…"
                        onChange={(e) => setThemeField('logoUrl', e.target.value)}
                      />
                    </label>

                    <h4 className="h6 mt-3 mb-2">Блоки страницы</h4>
                    <div className="online-store-add-block mb-2">
                      <select
                        className="form-select form-select-sm"
                        value={addBlockType}
                        onChange={(e) => setAddBlockType(e.target.value)}
                      >
                        {blockTypes.map((bt) => (
                          <option key={bt.type} value={bt.type}>
                            {bt.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-primary"
                        onClick={addLayoutBlock}
                      >
                        Добавить блок
                      </button>
                    </div>
                    <div className="online-store-blocks">
                      {layoutBlocks.map((b, idx) => {
                        const props = b.props || {};
                        const featuredIds = Array.isArray(props.productIds)
                          ? props.productIds.map(Number)
                          : [];
                        return (
                          <div key={b.id || idx} className="online-store-block-row">
                            <div className="online-store-block-top">
                              <label className="online-store-block-toggle">
                                <input
                                  type="checkbox"
                                  checked={b.enabled !== false}
                                  onChange={(e) => {
                                    const on = e.target.checked;
                                    setLayoutBlocks((prev) =>
                                      prev.map((x, i) => (i === idx ? { ...x, enabled: on } : x))
                                    );
                                  }}
                                />
                                <strong>{blockLabel(b.type)}</strong>
                              </label>
                              <div className="online-store-block-actions">
                                <button
                                  type="button"
                                  className="btn btn-sm btn-outline-secondary"
                                  disabled={idx === 0}
                                  onClick={() =>
                                    setLayoutBlocks((prev) => {
                                      if (idx <= 0) return prev;
                                      const next = [...prev];
                                      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                                      return next;
                                    })
                                  }
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-sm btn-outline-secondary"
                                  disabled={idx >= layoutBlocks.length - 1}
                                  onClick={() =>
                                    setLayoutBlocks((prev) => {
                                      if (idx >= prev.length - 1) return prev;
                                      const next = [...prev];
                                      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                                      return next;
                                    })
                                  }
                                >
                                  ↓
                                </button>
                                {b.type !== 'catalog' ? (
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-outline-danger"
                                    onClick={() => removeLayoutBlock(idx)}
                                  >
                                    ×
                                  </button>
                                ) : null}
                              </div>
                            </div>

                            {b.type === 'hero' ? (
                              <div className="online-store-block-fields">
                                <input
                                  className="form-control form-control-sm"
                                  placeholder="Заголовок (пусто = название магазина)"
                                  value={props.title || ''}
                                  onChange={(e) => updateBlockProps(idx, { title: e.target.value })}
                                />
                                <input
                                  className="form-control form-control-sm"
                                  placeholder="Подзаголовок (пусто = слоган)"
                                  value={props.subtitle || ''}
                                  onChange={(e) =>
                                    updateBlockProps(idx, { subtitle: e.target.value })
                                  }
                                />
                                <div className="row g-2">
                                  <div className="col-md-6">
                                    <input
                                      className="form-control form-control-sm"
                                      placeholder="Текст кнопки"
                                      value={props.ctaLabel || ''}
                                      onChange={(e) =>
                                        updateBlockProps(idx, { ctaLabel: e.target.value })
                                      }
                                    />
                                  </div>
                                  <div className="col-md-6">
                                    <input
                                      className="form-control form-control-sm"
                                      placeholder="Ссылка кнопки (#catalog)"
                                      value={props.ctaHref || ''}
                                      onChange={(e) =>
                                        updateBlockProps(idx, { ctaHref: e.target.value })
                                      }
                                    />
                                  </div>
                                </div>
                                <div className="d-flex flex-wrap gap-3">
                                  <label className="online-store-inline-check">
                                    <input
                                      type="checkbox"
                                      checked={props.showCta !== false}
                                      onChange={(e) =>
                                        updateBlockProps(idx, { showCta: e.target.checked })
                                      }
                                    />
                                    Показывать кнопку
                                  </label>
                                  <label className="online-store-inline-check">
                                    <input
                                      type="checkbox"
                                      checked={props.compact === true}
                                      onChange={(e) =>
                                        updateBlockProps(idx, { compact: e.target.checked })
                                      }
                                    />
                                    Компактная шапка
                                  </label>
                                </div>
                              </div>
                            ) : null}

                            {b.type === 'banner' ? (
                              <div className="online-store-block-fields">
                                <input
                                  className="form-control form-control-sm"
                                  placeholder="URL картинки баннера"
                                  value={props.imageUrl || ''}
                                  onChange={(e) =>
                                    updateBlockProps(idx, { imageUrl: e.target.value })
                                  }
                                />
                                <input
                                  className="form-control form-control-sm"
                                  placeholder="Ссылка по клику"
                                  value={props.href || ''}
                                  onChange={(e) => updateBlockProps(idx, { href: e.target.value })}
                                />
                                <input
                                  className="form-control form-control-sm"
                                  placeholder="Подпись (alt)"
                                  value={props.alt || ''}
                                  onChange={(e) => updateBlockProps(idx, { alt: e.target.value })}
                                />
                              </div>
                            ) : null}

                            {b.type === 'featured' ? (
                              <div className="online-store-block-fields">
                                <input
                                  className="form-control form-control-sm"
                                  placeholder="Заголовок подборки"
                                  value={props.title || ''}
                                  onChange={(e) => updateBlockProps(idx, { title: e.target.value })}
                                />
                                <div className="online-store-featured-pick">
                                  {catalog.slice(0, 80).map((p) => {
                                    const id = Number(p.id);
                                    const on = featuredIds.includes(id);
                                    return (
                                      <label
                                        key={id}
                                        className={`online-store-pick-row${on ? ' is-on' : ''}`}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={on}
                                          onChange={() => {
                                            const set = new Set(featuredIds);
                                            if (set.has(id)) set.delete(id);
                                            else if (set.size < 24) set.add(id);
                                            updateBlockProps(idx, {
                                              productIds: [...set],
                                            });
                                          }}
                                        />
                                        <span className="online-store-pick-meta">
                                          <strong>{p.name}</strong>
                                          <span className="text-muted">{p.sku || '—'}</span>
                                        </span>
                                      </label>
                                    );
                                  })}
                                  {!catalog.length ? (
                                    <div className="text-muted small">Нет товаров для подборки</div>
                                  ) : null}
                                </div>
                              </div>
                            ) : null}

                            {b.type === 'catalog' ? (
                              <div className="online-store-block-fields">
                                <input
                                  className="form-control form-control-sm"
                                  placeholder="Заголовок каталога"
                                  value={props.title || ''}
                                  onChange={(e) => updateBlockProps(idx, { title: e.target.value })}
                                />
                                <div className="btn-group" role="group">
                                  <button
                                    type="button"
                                    className={`btn btn-sm ${
                                      (props.density || 'grid') === 'grid'
                                        ? 'btn-primary'
                                        : 'btn-outline-secondary'
                                    }`}
                                    onClick={() => updateBlockProps(idx, { density: 'grid' })}
                                  >
                                    Сетка
                                  </button>
                                  <button
                                    type="button"
                                    className={`btn btn-sm ${
                                      props.density === 'list'
                                        ? 'btn-primary'
                                        : 'btn-outline-secondary'
                                    }`}
                                    onClick={() => updateBlockProps(idx, { density: 'list' })}
                                  >
                                    Список
                                  </button>
                                </div>
                              </div>
                            ) : null}

                            {b.type === 'rich_text' ? (
                              <div className="online-store-block-fields">
                                <input
                                  className="form-control form-control-sm"
                                  placeholder="Заголовок"
                                  value={props.title || ''}
                                  onChange={(e) => updateBlockProps(idx, { title: e.target.value })}
                                />
                                <textarea
                                  className="form-control form-control-sm"
                                  rows={3}
                                  placeholder="Текст блока"
                                  value={props.body || ''}
                                  onChange={(e) => updateBlockProps(idx, { body: e.target.value })}
                                />
                              </div>
                            ) : null}

                            {b.type === 'contacts' ? (
                              <p className="small text-muted mb-0">
                                Берёт телефон, email и адрес из настроек магазина выше.
                              </p>
                            ) : null}
                          </div>
                        );
                      })}
                      {!layoutBlocks.length ? (
                        <div className="text-muted small">
                          Сохраните магазин с шаблоном — появится стартовая раскладка блоков.
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="online-store-editor-locked">
                    <p className="mb-2">
                      Подробный дизайн витрины (цвета, шрифты, блоки, баннер, подборки) доступен на
                      тарифе <strong>Про</strong>.
                    </p>
                    <Link className="btn btn-sm btn-outline-primary" to="/pricing?plan=pro">
                      Тариф Про
                    </Link>
                  </div>
                )}

                <h3 className="h6 mt-4 mb-2">Свой домен</h3>
                {customDomainEnabled ? (
                  <div className="online-store-domain">
                    <label className="online-store-label">
                      Домен витрины
                      <input
                        className="form-control"
                        value={customDomain}
                        placeholder="shop.example.ru"
                        onChange={(e) => setCustomDomain(e.target.value.trim().toLowerCase())}
                      />
                    </label>
                    {domainMeta.status && domainMeta.status !== 'none' ? (
                      <p className="small mb-2">
                        Статус:{' '}
                        <span className={`online-store-domain-status is-${domainMeta.status}`}>
                          {domainMeta.status === 'pending'
                            ? 'ожидает DNS'
                            : domainMeta.status === 'active'
                              ? 'активен'
                              : domainMeta.status === 'failed'
                                ? 'ошибка'
                                : domainMeta.status}
                        </span>
                        {domainMeta.error ? ` — ${domainMeta.error}` : ''}
                      </p>
                    ) : null}
                    {domainMeta.dns?.cnameTarget ? (
                      <div className="online-store-domain-dns small text-muted mb-2">
                        <div>
                          CNAME: <code>{domainMeta.dns.domain || customDomain}</code> →{' '}
                          <code>{domainMeta.dns.cnameTarget}</code>
                        </div>
                        <ul className="mb-0 ps-3">
                          {(domainMeta.dns.steps || []).map((step) => (
                            <li key={step}>{step}</li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <p className="small text-muted mb-2">
                        Укажите домен и сохраните — появятся инструкции по DNS (CNAME на платформу).
                        SSL и привязка на сервере — следующий шаг после проверки записи.
                      </p>
                    )}
                    {customDomain || domainMeta.status !== 'none' ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        disabled={saving}
                        onClick={async () => {
                          setSaving(true);
                          setError('');
                          setOkMsg('');
                          try {
                            const data = await onlineStoreApi.saveMine({ clearCustomDomain: true });
                            setCustomDomainEnabled(!!data?.customDomainEnabled);
                            const s = data?.store;
                            setCustomDomain(s?.customDomain || '');
                            setDomainMeta({
                              status: s?.customDomainStatus || 'none',
                              error: s?.customDomainError || '',
                              dns: s?.dns || null,
                            });
                            setOkMsg('Домен отвязан');
                          } catch (e) {
                            setError(e?.response?.data?.message || e?.message || 'Не удалось отвязать');
                          } finally {
                            setSaving(false);
                          }
                        }}
                      >
                        Отвязать домен
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <div className="online-store-editor-locked">
                    <p className="mb-2">
                      Свой домен (CNAME на витрину) доступен на тарифе <strong>Про</strong>. Сейчас
                      витрина открывается по адресу <code>/s/…</code>.
                    </p>
                    <Link className="btn btn-sm btn-outline-primary" to="/pricing?plan=pro">
                      Тариф Про
                    </Link>
                  </div>
                )}

                <div className="d-flex flex-wrap gap-2 mt-4">
                  <Button type="button" variant="primary" disabled={saving} onClick={() => save()}>
                    {saving ? 'Сохраняем…' : 'Сохранить'}
                  </Button>
                  {form.published ? (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={saving}
                      onClick={() => save({ publish: false })}
                    >
                      Снять с публикации
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="success"
                      disabled={saving || !form.slug || !privateOk || !warehouseId}
                      onClick={() => save({ publish: true })}
                    >
                      Опубликовать
                    </Button>
                  )}
                  {form.published && form.slug ? (
                    <a className="btn btn-outline-primary btn-sm" href={`/s/${form.slug}`} target="_blank" rel="noreferrer">
                      Открыть витрину
                    </a>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          <div className="col-lg-5">
            <div
              className="card online-store-card online-store-preview"
              style={{
                '--store-brand': theme.brandColor || form.brandColor,
                background: theme.backgroundColor || undefined,
                color: theme.textColor || undefined,
              }}
            >
              <div className="card-body">
                <div className="online-store-preview-badge">Превью · {form.templateCode}</div>
                <div className="online-store-preview-hero">
                  <div className="online-store-preview-name">{form.name || 'Мой магазин'}</div>
                  <div className="online-store-preview-tag">{form.tagline || 'Товары из вашего каталога'}</div>
                </div>
                <div className="online-store-preview-grid">
                  {(catalog.slice(0, form.templateCode === 'catalog' ? 4 : 3) || []).map((p) => (
                    <div key={p.id} className="online-store-preview-card">
                      <div className="online-store-preview-thumb" />
                      <div className="online-store-preview-title">{p.name}</div>
                      <div className="online-store-preview-price">
                        {p.price != null ? `${Number(p.price).toLocaleString('ru-RU')} ₽` : '—'}
                      </div>
                    </div>
                  ))}
                  {!catalog.length ? (
                    <div className="text-muted small">Добавьте товары в каталог — здесь появится превью</div>
                  ) : null}
                </div>
                <p className="small text-muted mt-3 mb-0">
                  В отличие от Mag1c — живые остатки и цены из ERP, смена шаблона и цвета без отдельной CMS.
                  Заказы падают в раздел «Заказы» как частные.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default OnlineStoreAdmin;
