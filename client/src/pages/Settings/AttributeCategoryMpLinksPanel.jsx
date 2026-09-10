import React, { useEffect, useMemo, useState } from 'react';
import { userCategoriesApi } from '../../services/userCategories.api';
import { Button } from '../../components/common/Button/Button';
import { AttributeMpLinkFields } from '../../components/common/AttributeMpLinkFields/AttributeMpLinkFields.jsx';
import {
  attrMpLinksHasAny,
  emptyAttrMpLinks,
  formatAttrMpLinksSummary,
  normalizeAttrMpLinks,
} from '../../utils/productAttributeMpLinks.js';
import {
  listAddedDedicatedMainKeys,
  normalizeCategoryDedicatedCharcLinks,
  serializeCategoryDedicatedCharcLinks,
  withMpOfferFieldAttrs,
} from '../../utils/productMpFieldLinks.js';
import { useAuth } from '../../context/AuthContext.jsx';

function mpAttrsFromResponse(res) {
  const raw = res?.data ?? res;
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.attributes)) return raw.attributes;
  if (Array.isArray(raw?.data)) return raw.data;
  return [];
}

function wbAttrKey(a) {
  const id = a?.charcID ?? a?.characteristic_id ?? a?.id ?? a?.attribute_id ?? a?.name;
  return id != null ? String(id) : String(a?.name || '');
}

function wbAttrName(a) {
  return a?.name ?? a?.charcName ?? a?.characteristic_name ?? '';
}

function linksOfCategory(cat, { attributeId, dedicatedKey } = {}) {
  if (dedicatedKey) {
    const dedicated = normalizeCategoryDedicatedCharcLinks(cat?.mp_field_links);
    return normalizeAttrMpLinks(dedicated[dedicatedKey]);
  }
  const map = cat?.attribute_mp_links && typeof cat.attribute_mp_links === 'object'
    ? cat.attribute_mp_links
    : {};
  return normalizeAttrMpLinks(map[String(attributeId)] ?? map[attributeId]);
}

function categoryHasMapping(cat, spec) {
  if (spec.dedicatedKey) {
    const added = listAddedDedicatedMainKeys(cat?.mp_field_links);
    return added.includes(spec.dedicatedKey) || attrMpLinksHasAny(linksOfCategory(cat, spec));
  }
  return (cat?.attribute_ids || []).map((id) => String(id)).includes(String(spec.attributeId))
    && attrMpLinksHasAny(linksOfCategory(cat, spec));
}

function categoryPathName(cat, all) {
  const parentId = cat?.parent_id ?? cat?.parentId;
  if (!parentId) return cat?.name || String(cat?.id || '');
  const parent = (all || []).find((c) => String(c.id) === String(parentId));
  return parent ? `${parent.name} / ${cat.name}` : cat.name;
}

function patchCategoryAttributeState(cat, attributeId, nextLinks) {
  const ids = [...new Set([...(cat.attribute_ids || []).map(String), String(attributeId)])];
  return {
    ...cat,
    attribute_ids: ids,
    attribute_mp_links: {
      ...(cat.attribute_mp_links || {}),
      [String(attributeId)]: nextLinks,
    },
  };
}

function patchDedicatedCategoryState(cat, fieldKey, nextLinks) {
  const current = normalizeCategoryDedicatedCharcLinks(cat.mp_field_links);
  const added = listAddedDedicatedMainKeys(cat.mp_field_links);
  const has = attrMpLinksHasAny(nextLinks);
  const nextAdded = has
    ? (added.includes(fieldKey) ? added : [...added, fieldKey])
    : added.filter((key) => key !== fieldKey);
  return {
    ...cat,
    mp_field_links: serializeCategoryDedicatedCharcLinks(
      { ...current, [fieldKey]: normalizeAttrMpLinks(nextLinks) },
      nextAdded
    ),
  };
}

function linksSignature(links) {
  return JSON.stringify(normalizeAttrMpLinks(links));
}

function commonLinksOf(cats, spec) {
  if (!cats.length) return { links: emptyAttrMpLinks(), mixed: false };
  const first = linksSignature(linksOfCategory(cats[0], spec));
  const mixed = cats.some((c) => linksSignature(linksOfCategory(c, spec)) !== first);
  return {
    links: mixed ? emptyAttrMpLinks() : linksOfCategory(cats[0], spec),
    mixed,
  };
}

function mergeMpAttrOptions(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists || []) {
    for (const attr of list || []) {
      const id = String(attr?.charcID ?? attr?.characteristic_id ?? attr?.id ?? attr?.attribute_id ?? '');
      const name = String(attr?.name ?? attr?.charcName ?? attr?.characteristic_name ?? '').toLowerCase();
      const key = `${id}|${name}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(attr);
    }
  }
  return out;
}

export function AttributeCategoryMpLinksPanel({ attributeId, dedicatedKey }) {
  const spec = useMemo(
    () => (dedicatedKey ? { dedicatedKey } : { attributeId }),
    [attributeId, dedicatedKey]
  );
  const scopeName = dedicatedKey || attributeId;
  const { selectedOrganizationId } = useAuth();
  const [categories, setCategories] = useState([]);
  const [scope, setScope] = useState('all');
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [links, setLinks] = useState(() => emptyAttrMpLinks());
  const [mixed, setMixed] = useState(false);
  const [ozonOptions, setOzonOptions] = useState([]);
  const [wbOptions, setWbOptions] = useState([]);
  const [ymOptions, setYmOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    userCategoriesApi
      .getAll()
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.data) ? res.data : [];
        setCategories(list);
        const linked = list.filter((c) => categoryHasMapping(c, spec));
        if (linked.length > 0 && linked.length < list.length) {
          setScope('selected');
          setSelectedIds(new Set(linked.map((c) => String(c.id))));
        } else {
          setScope('all');
          setSelectedIds(new Set());
        }
      })
      .catch(() => {
        if (!cancelled) setCategories([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attributeId, dedicatedKey]);

  const sortedCategories = useMemo(
    () =>
      categories
        .slice()
        .sort((a, b) =>
          String(categoryPathName(a, categories)).localeCompare(String(categoryPathName(b, categories)), 'ru')
        ),
    [categories]
  );

  const targetCategories = useMemo(() => {
    if (scope === 'all') return sortedCategories;
    return sortedCategories.filter((c) => selectedIds.has(String(c.id)));
  }, [scope, sortedCategories, selectedIds]);

  const targetKey = scope === 'all' ? 'all' : [...selectedIds].sort().join(',');

  useEffect(() => {
    const common = commonLinksOf(targetCategories, spec);
    setLinks(common.links);
    setMixed(common.mixed);
  }, [attributeId, dedicatedKey, targetKey, categories, targetCategories]);

  useEffect(() => {
    const sample = targetCategories.slice(0, 8);
    setOzonOptions(withMpOfferFieldAttrs('ozon', []));
    setWbOptions(withMpOfferFieldAttrs('wb', []));
    setYmOptions(withMpOfferFieldAttrs('ym', []));
    if (!sample.length) return undefined;
    let cancelled = false;
    Promise.all(
      sample.flatMap((cat) => [
        userCategoriesApi
          .getMarketplaceAttributes(cat.id, 'ozon', { organizationId: selectedOrganizationId || undefined })
          .catch(() => null),
        userCategoriesApi
          .getMarketplaceAttributes(cat.id, 'wb', { organizationId: selectedOrganizationId || undefined })
          .catch(() => null),
        userCategoriesApi
          .getMarketplaceAttributes(cat.id, 'ym', { organizationId: selectedOrganizationId || undefined })
          .catch(() => null),
      ])
    ).then((results) => {
      if (cancelled) return;
      const oz = [];
      const wb = [];
      const ym = [];
      for (let i = 0; i < results.length; i += 3) {
        oz.push(mpAttrsFromResponse(results[i]));
        wb.push(mpAttrsFromResponse(results[i + 1]));
        ym.push(mpAttrsFromResponse(results[i + 2]));
      }
      setOzonOptions(withMpOfferFieldAttrs('ozon', mergeMpAttrOptions(oz)));
      setWbOptions(withMpOfferFieldAttrs('wb', mergeMpAttrOptions(wb)));
      setYmOptions(withMpOfferFieldAttrs('ym', mergeMpAttrOptions(ym)));
    });
    return () => {
      cancelled = true;
    };
  }, [attributeId, dedicatedKey, selectedOrganizationId, targetKey, targetCategories]);

  const toggleCategory = (id, checked) => {
    const key = String(id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const applyLinks = async () => {
    if (scope === 'selected' && selectedIds.size === 0) {
      alert('Выберите хотя бы одну категорию');
      return;
    }
    if (!categories.length) {
      alert('Сначала создайте категории');
      return;
    }
    setSaving(true);
    try {
      const payload =
        scope === 'all'
          ? { mp_links: links, scope: 'all' }
          : { mp_links: links, scope: 'selected', category_ids: [...selectedIds] };
      if (dedicatedKey) {
        await userCategoriesApi.updateDedicatedMpLinksBulk(dedicatedKey, payload);
      } else {
        await userCategoriesApi.updateAttributeMpLinksBulk(attributeId, payload);
      }
      const applyIds =
        scope === 'all' ? new Set(categories.map((c) => String(c.id))) : new Set([...selectedIds]);
      setCategories((prev) =>
        prev.map((c) => {
          if (!applyIds.has(String(c.id))) return c;
          return dedicatedKey
            ? patchDedicatedCategoryState(c, dedicatedKey, links)
            : patchCategoryAttributeState(c, attributeId, links);
        })
      );
      setMixed(false);
    } catch (err) {
      alert(err?.response?.data?.message || err?.response?.data?.error || 'Не удалось сохранить связь');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="muted" style={{ margin: 0 }}>Загрузка категорий…</p>;
  }

  const allSelected = sortedCategories.length > 0 && selectedIds.size === sortedCategories.length;

  return (
    <div className="attribute-category-mp-links">
      <div className="attribute-mp-scope" role="radiogroup" aria-label="К каким категориям применить связь">
        <label className="checkbox-label">
          <input
            type="radio"
            name={`attr-mp-scope-${scopeName}`}
            checked={scope === 'all'}
            onChange={() => setScope('all')}
            disabled={saving}
          />
          Все категории{categories.length ? ` (${categories.length})` : ''}
        </label>
        <label className="checkbox-label">
          <input
            type="radio"
            name={`attr-mp-scope-${scopeName}`}
            checked={scope === 'selected'}
            onChange={() => setScope('selected')}
            disabled={saving}
          />
          Выбранные категории
        </label>
      </div>
      {scope === 'selected' ? (
        <div className="attribute-mp-scope-list">
          <div className="attribute-mp-scope-toolbar">
            <button
              type="button"
              className="btn btn-outline-secondary btn-sm"
              disabled={saving || !sortedCategories.length}
              onClick={() =>
                setSelectedIds(
                  allSelected ? new Set() : new Set(sortedCategories.map((c) => String(c.id)))
                )
              }
            >
              {allSelected ? 'Снять все' : 'Выбрать все'}
            </button>
            <span className="muted">Отмечено: {selectedIds.size}</span>
          </div>
          {sortedCategories.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>Категорий пока нет</p>
          ) : (
            <div className="category-checkboxes">
              {sortedCategories.map((c) => {
                const id = String(c.id);
                return (
                  <label key={id} className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(id)}
                      disabled={saving}
                      onChange={(e) => toggleCategory(id, e.target.checked)}
                    />
                    <span>{categoryPathName(c, categories)}</span>
                    {attrMpLinksHasAny(linksOfCategory(c, spec)) ? (
                      <span className="muted">{formatAttrMpLinksSummary(linksOfCategory(c, spec))}</span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
      {mixed ? (
        <p className="form-hint">
          У {scope === 'all' ? 'категорий' : 'выбранных категорий'} сейчас разные связи. Задайте набор ниже
          и нажмите «Применить» — он запишется {scope === 'all' ? 'во все категории' : 'в отмеченные'}.
        </p>
      ) : (
        <p className="form-hint">
          Один набор характеристик OZ / WB / ЯМ для {scope === 'all' ? 'всех категорий' : 'отмеченных категорий'}.
          Списки характеристик собраны по сопоставленным категориям маркетплейсов; можно вписать название вручную.
        </p>
      )}
      <AttributeMpLinkFields
        links={links}
        onChange={setLinks}
        ozonOptions={ozonOptions}
        wbOptions={wbOptions}
        ymOptions={ymOptions}
        getWbId={wbAttrKey}
        getWbName={wbAttrName}
        disabled={saving}
      />
      <div className="attribute-mp-apply">
        <Button type="button" variant="primary" size="small" disabled={saving} onClick={() => void applyLinks()}>
          {saving ? 'Сохранение…' : 'Применить связь'}
        </Button>
      </div>
    </div>
  );
}
