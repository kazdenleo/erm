import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
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

/**
 * Общий набор для редактора.
 * Если у части категорий один и тот же маппинг, а у остальных пусто —
 * показываем этот маппинг (не пустой редактор), иначе «Сохранить» затирало связи.
 */
function commonLinksOf(cats, spec) {
  if (!cats.length) {
    return { links: emptyAttrMpLinks(), mixed: false, mappedCount: 0, total: 0 };
  }
  const total = cats.length;
  const perCat = cats.map((c) => linksOfCategory(c, spec));
  const withLinks = perCat.filter((links) => attrMpLinksHasAny(links));
  const mappedCount = withLinks.length;
  if (!mappedCount) {
    return { links: emptyAttrMpLinks(), mixed: false, mappedCount: 0, total };
  }
  const firstSig = linksSignature(withLinks[0]);
  const allMappedSame = withLinks.every((links) => linksSignature(links) === firstSig);
  if (!allMappedSame) {
    return { links: emptyAttrMpLinks(), mixed: true, mappedCount, total };
  }
  const everyoneSame = mappedCount === total
    && perCat.every((links) => linksSignature(links) === firstSig);
  return {
    links: normalizeAttrMpLinks(withLinks[0]),
    mixed: !everyoneSame,
    mappedCount,
    total,
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

export const AttributeCategoryMpLinksPanel = forwardRef(function AttributeCategoryMpLinksPanel(
  { attributeId, dedicatedKey },
  ref
) {
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
  const [mappedCount, setMappedCount] = useState(0);
  const [ozonOptions, setOzonOptions] = useState([]);
  const [wbOptions, setWbOptions] = useState([]);
  const [ymOptions, setYmOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const dirtyRef = useRef(false);
  const linksRef = useRef(links);
  const scopeRef = useRef(scope);
  const selectedIdsRef = useRef(selectedIds);
  const categoriesRef = useRef(categories);

  useEffect(() => {
    linksRef.current = links;
  }, [links]);
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);
  useEffect(() => {
    selectedIdsRef.current = selectedIds;
  }, [selectedIds]);
  useEffect(() => {
    categoriesRef.current = categories;
  }, [categories]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStatus('');
    dirtyRef.current = false;
    setScope('all');
    setSelectedIds(new Set());
    setLinks(emptyAttrMpLinks());
    setMixed(false);
    setMappedCount(0);
    userCategoriesApi
      .getAll()
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.data) ? res.data : [];
        setCategories(list);
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

  // Подтягиваем связи с сервера только если пользователь ещё не правил черновик.
  // Иначе смена «все/выбранные» или доп. галочки обнуляла редактор и «Сохранить» затирало БД.
  useEffect(() => {
    const common = commonLinksOf(targetCategories, spec);
    setMixed(common.mixed);
    setMappedCount(common.mappedCount);
    if (dirtyRef.current) return;
    setLinks(common.links);
  }, [attributeId, dedicatedKey, targetKey, categories, targetCategories, spec]);

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

  const onLinksChange = useCallback((next) => {
    dirtyRef.current = true;
    setStatus('');
    setLinks(normalizeAttrMpLinks(next));
  }, []);

  const applyLinks = async ({ silent = false, force = false } = {}) => {
    const currentScope = scopeRef.current;
    const currentSelected = selectedIdsRef.current;
    const currentCategories = categoriesRef.current;
    const currentLinks = normalizeAttrMpLinks(linksRef.current);
    const targets =
      currentScope === 'all'
        ? currentCategories
        : currentCategories.filter((c) => currentSelected.has(String(c.id)));

    if (currentScope === 'selected' && currentSelected.size === 0) {
      const msg = 'Выберите хотя бы одну категорию';
      if (!silent) alert(msg);
      throw new Error(msg);
    }
    if (!currentCategories.length) {
      const msg = 'Сначала создайте категории';
      if (!silent) alert(msg);
      throw new Error(msg);
    }

    // На «Сохранить» формы не затираем БД пустым набором, если пользователь связи не трогал.
    if (!force && !dirtyRef.current && !attrMpLinksHasAny(currentLinks)) {
      const common = commonLinksOf(targets, spec);
      if (common.mixed || common.mappedCount > 0) {
        return { updated: 0, skipped: true };
      }
    }

    setSaving(true);
    setStatus('');
    try {
      const payload =
        currentScope === 'all'
          ? { mp_links: currentLinks, scope: 'all' }
          : { mp_links: currentLinks, scope: 'selected', category_ids: [...currentSelected] };
      const res = dedicatedKey
        ? await userCategoriesApi.updateDedicatedMpLinksBulk(dedicatedKey, payload)
        : await userCategoriesApi.updateAttributeMpLinksBulk(attributeId, payload);
      const updated = Number(res?.data?.updated ?? res?.updated ?? 0);
      const applyIds =
        currentScope === 'all'
          ? new Set(currentCategories.map((c) => String(c.id)))
          : new Set([...currentSelected]);
      setCategories((prev) =>
        prev.map((c) => {
          if (!applyIds.has(String(c.id))) return c;
          return dedicatedKey
            ? patchDedicatedCategoryState(c, dedicatedKey, currentLinks)
            : patchCategoryAttributeState(c, attributeId, currentLinks);
        })
      );
      dirtyRef.current = false;
      setMixed(false);
      setMappedCount(attrMpLinksHasAny(currentLinks) ? applyIds.size : 0);
      const okMsg =
        currentScope === 'all'
          ? `Связь сохранена для ${updated || applyIds.size} категорий`
          : `Связь сохранена для ${updated || applyIds.size} выбранных категорий`;
      setStatus(okMsg);
      return { updated: updated || applyIds.size, skipped: false };
    } catch (err) {
      const msg =
        err?.response?.data?.message
        || err?.response?.data?.error
        || err?.message
        || 'Не удалось сохранить связь';
      setStatus('');
      if (!silent) alert(msg);
      throw err instanceof Error ? err : new Error(msg);
    } finally {
      setSaving(false);
    }
  };

  useImperativeHandle(ref, () => ({
    /** Сохранение из формы: не затирает пустым, если связи не меняли. */
    apply: () => applyLinks({ silent: true, force: false }),
    /** Явное «Применить связь» — всегда пишет текущий набор. */
    applyForce: () => applyLinks({ silent: false, force: true }),
    isSaving: () => saving,
  }));

  if (loading) {
    return <p className="muted" style={{ margin: 0 }}>Загрузка категорий…</p>;
  }

  const allSelected = sortedCategories.length > 0 && selectedIds.size === sortedCategories.length;
  const targetTotal = targetCategories.length;

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
          Сейчас связь задана у {mappedCount} из {targetTotal || categories.length} категорий
          {attrMpLinksHasAny(links) ? ' (ниже — общий набор из уже настроенных)' : ''}.
          «Сохранить» запишет набор ниже {scope === 'all' ? 'во все категории' : 'в отмеченные'}.
        </p>
      ) : (
        <p className="form-hint">
          Один набор характеристик OZ / WB / ЯМ для {scope === 'all' ? 'всех категорий' : 'отмеченных категорий'}.
          Сохраняется кнопкой «Сохранить» внизу формы.
        </p>
      )}
      <AttributeMpLinkFields
        links={links}
        onChange={onLinksChange}
        ozonOptions={ozonOptions}
        wbOptions={wbOptions}
        ymOptions={ymOptions}
        getWbId={wbAttrKey}
        getWbName={wbAttrName}
        disabled={saving}
      />
      <div className="attribute-mp-apply">
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled={saving}
          onClick={() => void applyLinks({ force: true })}
        >
          {saving ? 'Сохранение…' : 'Применить связь'}
        </Button>
        {status ? <span className="attribute-mp-apply-status">{status}</span> : null}
      </div>
    </div>
  );
});
