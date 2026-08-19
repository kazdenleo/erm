/**
 * CategoryForm Component
 * Форма создания/редактирования категории
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../common/Button/Button';
import { categoriesApi } from '../../../services/categories.api';
import { categoryMappingsApi } from '../../../services/categoryMappings.api';
import { integrationsApi } from '../../../services/integrations.api';
import { userCategoriesApi } from '../../../services/userCategories.api';
import { CommissionSchemesRow } from '../../Categories/CategoryMarketplaceMappingBlock';
import {
  buildWbCommissionsMap,
  getWbCommissionSchemesForDisplay,
  getMpPriceCalcSchemeKey,
  resolveMpCommissionEntry,
} from '../../../utils/marketplaceCategoryCommissions';
import api from '../../../services/api';
import { AttributeMpLinkFields } from '../../common/AttributeMpLinkFields/AttributeMpLinkFields.jsx';
import { MpMappedMpBadges } from '../../common/MpFieldLinkToggles/MpFieldLinkToggles.jsx';
import { attrMpLinksHasAny, emptyAttrMpLinks, mappedMpsFromAttrLinks, normalizeAttrMpLinks } from '../../../utils/productAttributeMpLinks.js';
import {
  DEDICATED_MAIN_MAP_KEYS,
  emptyCategoryDedicatedCharcLinks,
  MP_FIELD_LINK_FIELD_LABELS,
  normalizeCategoryDedicatedCharcLinks,
  withYmOfferFieldAttrs,
} from '../../../utils/productMpFieldLinks.js';
import '../../../pages/Categories/Categories.css';

/** Сравнение путей Ozon: пробелы, ›/>, ё→е (часто расходится с отображением в UI) */
function normalizeOzonPathForMatch(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .replace(/\s*›\s*/g, ' > ')
    .replace(/\s*>\s*/g, ' > ')
    .replace(/ё/gi, 'е')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Из составного id Ozon «descriptionCategoryId_typeId» в списке категорий */
function formatWbCategoryList(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((cat) => ({
    id: cat.subjectID ?? cat.id,
    name: cat.subjectName ?? cat.name,
    marketplace_category_id: cat.subjectID ?? cat.id,
    marketplace: 'wb',
    parent_id: cat.parentID ?? cat.parent_id,
    parent_name: cat.parentName ?? cat.parent_name,
  }));
}

function parseMarketplaceMappings(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return typeof p === 'object' && p ? p : null;
    } catch {
      return null;
    }
  }
  return null;
}

function isPlaceholderMappingName(name) {
  if (!name || typeof name !== 'string') return true;
  return /^(WB|Ozon|Яндекс\.Маркет) #\d+/i.test(name.trim()) || name.startsWith('ID ');
}

function mappingLabelFromCategory(category, mp) {
  const key = mp === 'yandex' ? 'ym' : mp;
  const rows = category?.mappings?.[key];
  const row = Array.isArray(rows) ? rows[0] : null;
  const name = row?.marketplace_category_name;
  if (name && !isPlaceholderMappingName(name)) return name;
  const mm = parseMarketplaceMappings(category?.marketplace_mappings);
  if (key === 'ozon' && mm?.ozon_display) return mm.ozon_display;
  if (key === 'ym' && mm?.ym_display) return mm.ym_display;
  return null;
}

function wbNameFromCommissionRow(row) {
  if (!row) return null;
  let rawData = row.raw_data;
  if (typeof rawData === 'string') {
    try {
      rawData = JSON.parse(rawData);
    } catch {
      rawData = null;
    }
  }
  return rawData?.subjectName ?? row.subjectName ?? row.category_name ?? row.categoryName ?? null;
}

async function loadMpCommissionsPreview({ ozon, ym, userCategoryId }) {
  const ozonItems = ozon
    ? [{ id: ozon, userCategoryId: userCategoryId ?? null }]
    : [];
  const ymItems = ym
    ? [{ id: String(ym), userCategoryId: userCategoryId ?? null }]
    : [];
  if (!ozonItems.length && !ymItems.length) {
    return { ozon: {}, ym: {} };
  }

  const dbRes = await userCategoriesApi.previewMarketplaceCommissions({
    ozon: ozonItems,
    ym: ymItems,
    dbOnly: true,
  });
  const dbData = dbRes?.data ?? dbRes;
  let ozonMap = dbData?.ozon && typeof dbData.ozon === 'object' ? { ...dbData.ozon } : {};
  let ymMap = dbData?.ym && typeof dbData.ym === 'object' ? { ...dbData.ym } : {};

  const needLiveOzon = ozonItems.filter((item) => {
    const entry = resolveMpCommissionEntry({ ozon: ozonMap }, 'ozon', item.id);
    return !(entry?.schemes?.length > 0);
  });
  const needLiveYm = ymItems.filter((item) => {
    const entry = resolveMpCommissionEntry({ ym: ymMap }, 'ym', item.id);
    return !(entry?.schemes?.length > 0);
  });

  if (needLiveOzon.length || needLiveYm.length) {
    const liveRes = await userCategoriesApi.previewMarketplaceCommissions({
      ozon: needLiveOzon.length ? needLiveOzon : undefined,
      ym: needLiveYm.length ? needLiveYm : undefined,
    });
    const liveData = liveRes?.data ?? liveRes;
    if (liveData?.ozon) ozonMap = { ...ozonMap, ...liveData.ozon };
    if (liveData?.ym) ymMap = { ...ymMap, ...liveData.ym };
  }

  return { ozon: ozonMap, ym: ymMap };
}

function parseOzonCompositeId(ozonCategoryId) {
  const raw = ozonCategoryId != null ? String(ozonCategoryId).trim() : '';
  const u = raw.indexOf('_');
  if (u <= 0) return { descId: null, typeId: null };
  const descPart = raw.slice(0, u).trim();
  const typePart = raw.slice(u + 1).trim();
  const descId = parseInt(descPart, 10);
  const typeId = parseInt(typePart, 10);
  if (!Number.isFinite(descId) || descId <= 0 || !Number.isFinite(typeId) || typeId <= 0) {
    return { descId: null, typeId: null };
  }
  return { descId, typeId };
}

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

function parseAttributeMpLinksMap(raw) {
  const next = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return next;
  for (const [key, value] of Object.entries(raw)) {
    next[String(key)] = normalizeAttrMpLinks(value);
  }
  return next;
}

export function CategoryForm({ category, categories = [], allAttributes = [], marketplaceCategories: propsMarketplace, marketplaceCategoriesLoading: propsLoading, onRefreshOzonCategories, onRefreshWbCategories, onSubmit, onCancel }) {
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    parentId: '',
    skip_marketplace_stock_sync: false,
    wbCategoryId: '',
    ozonCategoryId: '',
    ymCategoryId: ''
  });
  const [attributeIds, setAttributeIds] = useState([]);
  const [attributeMpLinks, setAttributeMpLinks] = useState({});
  const [dedicatedMpLinks, setDedicatedMpLinks] = useState(() => emptyCategoryDedicatedCharcLinks());
  const [addedDedicatedKeys, setAddedDedicatedKeys] = useState([]);
  const [pickerValue, setPickerValue] = useState('');
  const [ozonMpAttrs, setOzonMpAttrs] = useState([]);
  const [wbMpAttrs, setWbMpAttrs] = useState([]);
  const [ymMpAttrs, setYmMpAttrs] = useState(() => withYmOfferFieldAttrs([]));
  
  const [errors, setErrors] = useState({});
  const [loadingCategories, setLoadingCategories] = useState({
    wb: false,
    ozon: false,
    ym: false
  });
  const [marketplaceCategories, setMarketplaceCategories] = useState({
    wb: [],
    ozon: [],
    ym: []
  });
  const [ozonSearchQuery, setOzonSearchQuery] = useState('');
  const [ozonDropdownOpen, setOzonDropdownOpen] = useState(false);
  const [ozonSelectedCategory, setOzonSelectedCategory] = useState(null);
  const [ozonRefreshing, setOzonRefreshing] = useState(false);
  const [wbRefreshing, setWbRefreshing] = useState(false);
  const [wbRefreshError, setWbRefreshError] = useState('');
  const [wbSearchQuery, setWbSearchQuery] = useState('');
  const [wbDropdownOpen, setWbDropdownOpen] = useState(false);
  const [wbSelectedCategory, setWbSelectedCategory] = useState(null);
  const [ymSearchQuery, setYmSearchQuery] = useState('');
  const [ymDropdownOpen, setYmDropdownOpen] = useState(false);
  const [ymSelectedCategory, setYmSelectedCategory] = useState(null);
  const [wbCommissionsReport, setWbCommissionsReport] = useState([]);
  const [mpCommissionsPreview, setMpCommissionsPreview] = useState({ ozon: {}, ym: {} });
  const [mpCommissionsLoading, setMpCommissionsLoading] = useState(false);
  const [mpCommissionsRefreshing, setMpCommissionsRefreshing] = useState(false);
  /** null | 'wb' | 'ozon' | 'ym' — открытый выбор категории МП */
  const [editingMpMapping, setEditingMpMapping] = useState(null);

  const wbCommissionsByCategoryId = useMemo(
    () => buildWbCommissionsMap(wbCommissionsReport),
    [wbCommissionsReport]
  );

  useEffect(() => {
    let cancelled = false;
    integrationsApi
      .getWildberriesCommissions()
      .then((res) => {
        if (cancelled) return;
        const report = res?.data?.report ?? res?.report ?? [];
        setWbCommissionsReport(Array.isArray(report) ? report : []);
      })
      .catch(() => {
        if (!cancelled) setWbCommissionsReport([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ozonId = formData.ozonCategoryId;
    const ymId = formData.ymCategoryId;
    if (!ozonId && !ymId) {
      setMpCommissionsPreview({ ozon: {}, ym: {} });
      setMpCommissionsLoading(false);
      return undefined;
    }
    setMpCommissionsLoading(true);
    loadMpCommissionsPreview({
      ozon: ozonId,
      ym: ymId,
      userCategoryId: category?.id,
    })
      .then((preview) => {
        if (!cancelled) setMpCommissionsPreview(preview);
      })
      .catch(() => {
        if (!cancelled) setMpCommissionsPreview({ ozon: {}, ym: {} });
      })
      .finally(() => {
        if (!cancelled) setMpCommissionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [formData.ozonCategoryId, formData.ymCategoryId, category?.id]);

  const handleRefreshMpCommissions = async () => {
    setMpCommissionsRefreshing(true);
    try {
      const ozon = formData.ozonCategoryId
        ? [{ id: formData.ozonCategoryId, userCategoryId: category?.id ?? null }]
        : [];
      const ym = formData.ymCategoryId
        ? [{ id: String(formData.ymCategoryId), userCategoryId: category?.id ?? null }]
        : [];
      const res = await userCategoriesApi.previewMarketplaceCommissions({ ozon, ym });
      const data = res?.data ?? res;
      setMpCommissionsPreview({
        ozon: data?.ozon && typeof data.ozon === 'object' ? data.ozon : {},
        ym: data?.ym && typeof data.ym === 'object' ? data.ym : {},
      });
    } catch (e) {
      alert('Не удалось обновить комиссии Ozon/YM: ' + (e?.response?.data?.message || e.message));
    } finally {
      setMpCommissionsRefreshing(false);
    }
  };

  const useProps = propsMarketplace != null && typeof propsMarketplace === 'object';
  const effective = useProps ? propsMarketplace : marketplaceCategories;
  const loading = useProps
    ? { wb: propsLoading, ozon: propsLoading, ym: propsLoading }
    : loadingCategories;

  // Справочники категорий МП — только при открытии выбора (не грузим при каждом открытии карточки)
  useEffect(() => {
    if (useProps || !editingMpMapping) return undefined;
    let cancelled = false;
    const load = async () => {
      setLoadingCategories((prev) => ({ ...prev, wb: true, ozon: true, ym: true }));
      try {
        const [wbRes, ozonRes, ymRes] = await Promise.all([
          categoriesApi.getAll('wb'),
          categoriesApi.getAll('ozon'),
          categoriesApi.getAll('ym'),
        ]);
        if (cancelled) return;
        setMarketplaceCategories({
          wb: wbRes?.data || [],
          ozon: ozonRes?.data || ozonRes || [],
          ym: ymRes?.data || [],
        });
      } catch (e) {
        if (!cancelled) console.error('[CategoryForm] Error loading marketplace categories:', e);
      } finally {
        if (!cancelled) setLoadingCategories((prev) => ({ ...prev, wb: false, ozon: false, ym: false }));
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [useProps, editingMpMapping]);

  useEffect(() => {
    setEditingMpMapping(null);
  }, [category?.id]);

  // ID и подписи сопоставлений — сразу из marketplace_mappings / enrich, без полных справочников МП
  useEffect(() => {
    if (!category) return;
    const mm = parseMarketplaceMappings(category.marketplace_mappings);
    if (!mm) return;

    const wbId = mm.wb ? String(mm.wb) : '';
    const ozonId = mm.ozon ? String(mm.ozon) : '';
    const ymId = mm.ym ? String(mm.ym) : '';

    setFormData((prev) => ({
      ...prev,
      wbCategoryId: wbId || prev.wbCategoryId,
      ozonCategoryId: ozonId || prev.ozonCategoryId,
      ymCategoryId: ymId || prev.ymCategoryId,
    }));

    const wbLabel = mappingLabelFromCategory(category, 'wb');
    if (wbLabel && !isPlaceholderMappingName(wbLabel)) {
      setWbSearchQuery(wbLabel);
    } else if (wbId) {
      const fromReport = wbNameFromCommissionRow(wbCommissionsByCategoryId.get(wbId));
      if (fromReport) setWbSearchQuery(fromReport);
    }

    if (mm.ozon_display) {
      setOzonSearchQuery(mm.ozon_display);
    } else {
      const ozonLabel = mappingLabelFromCategory(category, 'ozon');
      if (ozonLabel && !isPlaceholderMappingName(ozonLabel)) setOzonSearchQuery(ozonLabel);
    }

    const ymLabel = mappingLabelFromCategory(category, 'ym');
    if (mm.ym_display) {
      setYmSearchQuery(mm.ym_display);
    } else if (ymLabel && !isPlaceholderMappingName(ymLabel)) {
      setYmSearchQuery(ymLabel);
    }
  }, [category?.id, category?.marketplace_mappings, category?.mappings, wbCommissionsByCategoryId]);

  useEffect(() => {
    const ymId = formData.ymCategoryId;
    if (!ymId) return undefined;
    const stored = mappingLabelFromCategory(category, 'ym');
    if (stored && !isPlaceholderMappingName(stored)) return undefined;
    if (ymSearchQuery && !isPlaceholderMappingName(ymSearchQuery)) return undefined;

    let cancelled = false;
    categoriesApi
      .getById(ymId)
      .then((res) => {
        if (cancelled) return;
        const cat = res?.data ?? res;
        const label = cat?.path || cat?.name;
        if (label) {
          setYmSearchQuery(label);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [formData.ymCategoryId, category, ymSearchQuery]);

  const getMpCommissionSchemes = (marketplace, categoryId) => {
    const mp = String(marketplace || '').toLowerCase();
    const id = categoryId != null ? String(categoryId) : '';
    if (!id) return { schemes: [], note: null, priceCalcSchemeKey: null };
    if (mp === 'wb' || mp === 'wildberries') {
      const row = wbCommissionsByCategoryId.get(id);
      const wb = getWbCommissionSchemesForDisplay(row);
      return {
        schemes: wb.schemes,
        note: wb.note,
        priceCalcSchemeKey: wb.priceCalcSchemeKey,
      };
    }
    const entry = resolveMpCommissionEntry(mpCommissionsPreview, mp, id);
    const schemes = (entry?.schemes || []).map((s) => ({
      ...s,
      display: s.display ?? (s.percent != null ? `${s.percent}%` : null),
    })).filter((s) => s.display);
    let note = entry?.note ?? null;
    if (!schemes.length && !note && !mpCommissionsLoading) {
      note =
        mp === 'ozon' || mp === 'ym'
          ? 'Нет данных о комиссии — нажмите «Обновить комиссии Ozon/YM из API»'
          : null;
    }
    return {
      schemes,
      note,
      priceCalcSchemeKey: getMpPriceCalcSchemeKey(mp),
    };
  };

  const toggleMpEdit = (mp) => {
    setEditingMpMapping((prev) => (prev === mp ? null : mp));
  };

  const closeMpEdit = () => setEditingMpMapping(null);

  const mpDisplayName = (mp) => {
    const stored = mappingLabelFromCategory(category, mp);
    if (mp === 'wb') {
      if (!formData.wbCategoryId) return null;
      return (
        stored ||
        wbSelectedCategory?.name ||
        wbNameFromCommissionRow(wbCommissionsByCategoryId.get(String(formData.wbCategoryId))) ||
        (wbSearchQuery && !isPlaceholderMappingName(wbSearchQuery) ? wbSearchQuery : null) ||
        `ID ${formData.wbCategoryId}`
      );
    }
    if (mp === 'ozon') {
      if (!formData.ozonCategoryId) return null;
      return (
        stored ||
        ozonSelectedCategory?.path ||
        ozonSelectedCategory?.name ||
        (ozonSearchQuery && !isPlaceholderMappingName(ozonSearchQuery) ? ozonSearchQuery : null) ||
        `ID ${formData.ozonCategoryId}`
      );
    }
    if (mp === 'ym') {
      if (!formData.ymCategoryId) return null;
      return (
        stored ||
        ymSelectedCategory?.path ||
        ymSelectedCategory?.name ||
        (ymSearchQuery && !isPlaceholderMappingName(ymSearchQuery) ? ymSearchQuery : null) ||
        `ID ${formData.ymCategoryId}`
      );
    }
    return null;
  };

  const renderMpSummaryRow = (mp, badgeClass, mpLabel, categoryId) => {
    const name = mpDisplayName(mp);
    const mapped = Boolean(categoryId);
    const { schemes, note, priceCalcSchemeKey } = mapped
      ? getMpCommissionSchemes(mp, categoryId)
      : { schemes: [], note: null, priceCalcSchemeKey: null };
    const commissionNote = mpCommissionsLoading && mapped && (mp === 'ozon' || mp === 'ym')
      ? 'Загрузка комиссий…'
      : note;
    return (
      <div
        key={mp}
        className="category-form-mp-row"
        style={{ marginBottom: '12px', paddingBottom: '12px', borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', flexWrap: 'wrap' }}>
          <span className={`mp-badge ${badgeClass}`} style={{ marginTop: '2px' }}>
            {badgeClass === 'wb' ? 'WB' : badgeClass === 'ozon' ? 'OZ' : 'YM'}
          </span>
          <div style={{ flex: 1, minWidth: '180px' }}>
            <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '2px' }}>{mpLabel}</div>
            <div style={{ fontSize: '13px', fontWeight: 500, color: mapped ? 'var(--text)' : 'var(--muted)' }}>
              {mapped ? name : 'Не сопоставлено'}
            </div>
            {mapped && (
              <CommissionSchemesRow
                schemes={schemes}
                note={commissionNote}
                priceCalcSchemeKey={priceCalcSchemeKey}
              />
            )}
          </div>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <Button
              type="button"
              variant="secondary"
              size="small"
              onClick={() => toggleMpEdit(mp)}
            >
              {editingMpMapping === mp ? 'Скрыть' : mapped ? 'Изменить' : 'Выбрать'}
            </Button>
            {mapped && (
              <button
                type="button"
                title="Убрать сопоставление"
                onClick={() => {
                  closeMpEdit();
                  if (mp === 'wb') {
                    setWbSelectedCategory(null);
                    setWbSearchQuery('');
                    handleChange('wbCategoryId', '');
                  } else if (mp === 'ozon') {
                    setOzonSelectedCategory(null);
                    setOzonSearchQuery('');
                    handleChange('ozonCategoryId', '');
                  } else {
                    setYmSelectedCategory(null);
                    setYmSearchQuery('');
                    handleChange('ymCategoryId', '');
                  }
                }}
                style={{
                  padding: '4px 8px',
                  background: 'transparent',
                  border: '1px solid #e5e7eb',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  color: '#6b7280',
                  fontSize: '12px',
                }}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  // Загрузка существующих маппингов для категории
  // Выполняется после загрузки категорий маркетплейсов
  useEffect(() => {
    const loadExistingMappings = async () => {
      if (!category) return;
      if (loading.wb || loading.ozon || loading.ym) return;

      try {
        if (category.marketplace_mappings) {
          const savedMappings = typeof category.marketplace_mappings === 'string' 
            ? JSON.parse(category.marketplace_mappings) 
            : category.marketplace_mappings;
          
          const wbCategoryId = savedMappings.wb ? String(savedMappings.wb) : '';
          const ozonCategoryId = savedMappings.ozon ? String(savedMappings.ozon) : '';
          const ymCategoryId = savedMappings.ym ? String(savedMappings.ym) : '';
          const ymCat = ymCategoryId ? effective.ym.find(c => String(c.id) === ymCategoryId) : null;
          if (ymCat) {
            setYmSelectedCategory(ymCat);
            setYmSearchQuery(ymCat.name || '');
          }
          const wbCat = wbCategoryId ? effective.wb.find(c => String(c.id) === wbCategoryId) : null;
          if (wbCat) {
            setWbSelectedCategory(wbCat);
            setWbSearchQuery(wbCat.name || '');
          }
          let finalOzonCategoryId = ozonCategoryId || '';
          if (ozonCategoryId) {
            let selectedOzonCategory = effective.ozon.find(cat => {
              const catIdStr = String(cat.id);
              const mappingIdStr = String(ozonCategoryId);
              if (catIdStr === mappingIdStr) return true;
              if (catIdStr.replace('ozon_', '') === mappingIdStr) return true;
              if (catIdStr === `ozon_${mappingIdStr}`) return true;
              const catIdNum = catIdStr.replace('ozon_', '');
              const mappingIdNum = mappingIdStr.replace('ozon_', '');
              if (catIdNum === mappingIdNum) return true;
              return false;
            });
            if (savedMappings.ozon_display && (!selectedOzonCategory || !String(selectedOzonCategory.id || '').includes('_'))) {
              const want = normalizeOzonPathForMatch(savedMappings.ozon_display);
              let pathMatch = effective.ozon.find(
                (cat) => normalizeOzonPathForMatch(cat.path) === want && String(cat.id || '').includes('_')
              );
              if (!pathMatch && want.includes(' > ')) {
                const last = want.split(' > ').pop() || '';
                pathMatch = effective.ozon.find(
                  (cat) => String(cat.id || '').includes('_')
                    && normalizeOzonPathForMatch(cat.path).endsWith(last)
                );
              }
              if (pathMatch) selectedOzonCategory = pathMatch;
            }
            if (selectedOzonCategory) {
              finalOzonCategoryId = selectedOzonCategory.id;
              setOzonSelectedCategory(selectedOzonCategory);
              setOzonSearchQuery(
                savedMappings.ozon_display
                  || (selectedOzonCategory.path && selectedOzonCategory.path !== selectedOzonCategory.name ? selectedOzonCategory.path : null)
                  || selectedOzonCategory.name
                  || ''
              );
            } else if (savedMappings.ozon_display) {
              setOzonSearchQuery(savedMappings.ozon_display);
            } else {
              setOzonSearchQuery(ozonCategoryId ? `ID: ${ozonCategoryId}` : '');
            }
          }
          
          setFormData(prev => ({
            ...prev,
            wbCategoryId,
            ozonCategoryId: finalOzonCategoryId || prev.ozonCategoryId,
            ymCategoryId
          }));
          return;
        }
        
        const productsResponse = await api.get('/products');
        const allProducts = productsResponse.data?.data || [];
        const categoryProducts = allProducts.filter(
          p => p.user_category_id === category.id || String(p.user_category_id) === String(category.id)
        );

        if (categoryProducts.length === 0) return;

        const firstProduct = categoryProducts[0];
        try {
          const mappingsResponse = await categoryMappingsApi.getByProduct(firstProduct.id);
          const mappings = mappingsResponse.data?.data || mappingsResponse.data || [];
          
          const mappingsByMarketplace = {};
          mappings.forEach(mapping => {
            mappingsByMarketplace[mapping.marketplace] = mapping;
          });
          
          const wbMapping = mappingsByMarketplace.wb;
          const wbCategoryId = wbMapping?.category_id 
            ? String(wbMapping.category_id) 
            : '';
          const ozonMapping = mappingsByMarketplace.ozon;
          const ozonCategoryId = ozonMapping?.category_id 
            ? String(ozonMapping.category_id) 
            : '';
          const ymCategoryId = mappingsByMarketplace.ym?.category_id 
            ? String(mappingsByMarketplace.ym.category_id) 
            : '';
          
          const selectedOzonCategory = ozonCategoryId 
            ? effective.ozon.find(cat => {
                // Ozon категории могут иметь id в формате "ozon_123" или просто число
                const catIdStr = String(cat.id);
                const mappingIdStr = String(ozonCategoryId);
                // Пробуем разные варианты сравнения
                if (catIdStr === mappingIdStr) return true;
                if (catIdStr.replace('ozon_', '') === mappingIdStr) return true;
                if (catIdStr === `ozon_${mappingIdStr}`) return true;
                // Также проверяем числовые значения
                const catIdNum = catIdStr.replace('ozon_', '');
                const mappingIdNum = mappingIdStr.replace('ozon_', '');
                if (catIdNum === mappingIdNum) return true;
                return false;
              })
            : null;
          
          let mmForDisplay = category?.marketplace_mappings;
          if (typeof mmForDisplay === 'string') {
            try { mmForDisplay = JSON.parse(mmForDisplay || '{}'); } catch (_) { mmForDisplay = {}; }
          }
          const ozonDisplayFromCategory = mmForDisplay?.ozon_display || null;
          if (selectedOzonCategory) {
            setOzonSelectedCategory(selectedOzonCategory);
            setOzonSearchQuery(
              ozonDisplayFromCategory
                || (selectedOzonCategory.path && selectedOzonCategory.path !== selectedOzonCategory.name ? selectedOzonCategory.path : null)
                || selectedOzonCategory.name
                || ''
            );
            setFormData(prev => ({
              ...prev,
              ozonCategoryId: selectedOzonCategory.id
            }));
          } else {
            setOzonSelectedCategory(null);
            setOzonSearchQuery(ozonDisplayFromCategory || (ozonCategoryId ? `ID: ${ozonCategoryId}` : ''));
          }
          
          const ymCatFound = ymCategoryId ? effective.ym.find(c => String(c.id) === ymCategoryId) : null;
          if (ymCatFound) {
            setYmSelectedCategory(ymCatFound);
            setYmSearchQuery(ymCatFound.name || '');
          }
          const wbCategoryFound = effective.wb.find(c => String(c.id) === wbCategoryId);
          if (wbCategoryFound) {
            setWbSelectedCategory(wbCategoryFound);
            setWbSearchQuery(wbCategoryFound.name || '');
          }
          if (!wbCategoryFound && wbMapping?.marketplace_category_name && wbCategoryId) {
            const foundByName = effective.wb.find(c => 
              c.name === wbMapping.marketplace_category_name
            );
            if (foundByName) {
              setWbSelectedCategory(foundByName);
              setWbSearchQuery(foundByName.name || '');
              setFormData(prev => ({
                ...prev,
                wbCategoryId: String(foundByName.id),
                ozonCategoryId,
                ymCategoryId
              }));
              return;
            }
          }
          
          setFormData(prev => ({
            ...prev,
            wbCategoryId,
            ozonCategoryId: selectedOzonCategory ? selectedOzonCategory.id : (ozonCategoryId || ''),
            ymCategoryId
          }));
        } catch (err) {
          if (err.response?.status !== 404) {
            console.error('[CategoryForm] Error loading mappings:', err);
          }
        }
      } catch (error) {
        console.error('[CategoryForm] Error loading products:', error);
      }
    };

    loadExistingMappings();
  }, [category, loading.wb, loading.ozon, loading.ym, effective.wb, effective.ozon, effective.ym]);

  useEffect(() => {
    if (category) {
      setFormData(prev => ({
        ...prev,
        name: category.name || '',
        description: category.description || '',
        parentId: category.parent_id || category.parentId || '',
        skip_marketplace_stock_sync: category.skip_marketplace_stock_sync === true
        // Не сбрасываем wbCategoryId, ozonCategoryId, ymCategoryId здесь,
        // они устанавливаются в loadExistingMappings после загрузки категорий
      }));
      const ids = category.attribute_ids && Array.isArray(category.attribute_ids)
        ? category.attribute_ids.map((id) => String(id))
        : [];
      setAttributeIds(ids);
      setAttributeMpLinks(parseAttributeMpLinksMap(category.attribute_mp_links));
      const dedicated = normalizeCategoryDedicatedCharcLinks(category.mp_field_links);
      setDedicatedMpLinks(dedicated);
      setAddedDedicatedKeys(DEDICATED_MAIN_MAP_KEYS.filter((key) => attrMpLinksHasAny(dedicated[key])));
      setPickerValue('');
    } else {
      setFormData({
        name: '',
        description: '',
        parentId: '',
        skip_marketplace_stock_sync: false,
        wbCategoryId: '',
        ozonCategoryId: '',
        ymCategoryId: ''
      });
      setAttributeIds([]);
      setAttributeMpLinks({});
      setDedicatedMpLinks(emptyCategoryDedicatedCharcLinks());
      setAddedDedicatedKeys([]);
      setPickerValue('');
      setOzonSelectedCategory(null);
      setOzonSearchQuery('');
      setWbSelectedCategory(null);
      setWbSearchQuery('');
      setYmSelectedCategory(null);
      setYmSearchQuery('');
    }
  }, [category]);

  useEffect(() => {
    let cancelled = false;
    const { descId, typeId } = parseOzonCompositeId(formData.ozonCategoryId);
    const wbSubjectId = formData.wbCategoryId ? Number(formData.wbCategoryId) : 0;

    (async () => {
      let ozon = [];
      if (descId && typeId) {
        try {
          const raw = await integrationsApi.getOzonCategoryAttributes(descId, typeId);
          ozon = Array.isArray(raw) ? raw : mpAttrsFromResponse(raw);
        } catch {
          ozon = [];
        }
      } else if (category?.id) {
        try {
          ozon = mpAttrsFromResponse(await userCategoriesApi.getMarketplaceAttributes(category.id, 'ozon'));
        } catch {
          ozon = [];
        }
      }

      let wb = [];
      let ym = [];
      if (category?.id) {
        const [wbRes, ymRes] = await Promise.all([
          userCategoriesApi.getMarketplaceAttributes(category.id, 'wb', {
            subjectId: wbSubjectId > 0 ? wbSubjectId : undefined,
          }).catch(() => null),
          userCategoriesApi.getMarketplaceAttributes(category.id, 'ym').catch(() => null),
        ]);
        wb = mpAttrsFromResponse(wbRes);
        ym = mpAttrsFromResponse(ymRes);
      }

      if (!cancelled) {
        setOzonMpAttrs(ozon);
        setWbMpAttrs(wb);
        setYmMpAttrs(withYmOfferFieldAttrs(ym));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [category?.id, formData.ozonCategoryId, formData.wbCategoryId, formData.ymCategoryId]);

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };

  const validate = () => {
    const newErrors = {};
    
    if (!formData.name || !formData.name.trim()) {
      newErrors.name = 'Введите название категории';
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!validate()) {
      return;
    }

    // Преобразуем ID категорий
    // Для WB и YM - числа, для Ozon - строка (description_category_id)
    const wbCategoryId = formData.wbCategoryId && formData.wbCategoryId !== '' 
      ? (typeof formData.wbCategoryId === 'string' ? parseInt(formData.wbCategoryId, 10) : Number(formData.wbCategoryId))
      : null;
    
    // Для Ozon ID должен быть строкой (VARCHAR в БД)
    // Убираем префикс "ozon_" если есть, но оставляем как строку
    let ozonCategoryId = null;
    if (formData.ozonCategoryId && formData.ozonCategoryId !== '') {
      const ozonIdStr = String(formData.ozonCategoryId);
      // Убираем префикс "ozon_" если есть
      const cleanId = ozonIdStr.replace(/^ozon_/, '');
      // Проверяем, что это валидный ID (не пустая строка)
      if (cleanId && cleanId !== '' && cleanId !== 'undefined' && cleanId !== 'null') {
        ozonCategoryId = cleanId; // Оставляем как строку
      }
    }
    
    const ymCategoryId = formData.ymCategoryId && formData.ymCategoryId !== '' 
      ? (typeof formData.ymCategoryId === 'string' ? parseInt(formData.ymCategoryId, 10) : Number(formData.ymCategoryId))
      : null;

    const fromComposite = parseOzonCompositeId(ozonCategoryId);
    let ozonDescId = ozonSelectedCategory?.description_category_id != null ? Number(ozonSelectedCategory.description_category_id) : null;
    let ozonTypeId = ozonSelectedCategory?.type_id != null ? Number(ozonSelectedCategory.type_id) : null;
    if (fromComposite.descId != null && fromComposite.typeId != null) {
      ozonDescId = fromComposite.descId;
      ozonTypeId = fromComposite.typeId;
    }
    const isOzonType = String(ozonCategoryId || '').includes('_');
    const ozonDisplay = (isOzonType && (ozonSelectedCategory?.path || ozonSearchQuery)) ? (ozonSelectedCategory?.path || ozonSearchQuery) : null;
    const ymDisplay =
      ymSelectedCategory?.path ||
      ymSelectedCategory?.name ||
      (ymSearchQuery && !isPlaceholderMappingName(ymSearchQuery) ? ymSearchQuery : null);
    const payload = {
      name: formData.name.trim(),
      description: formData.description.trim() || null,
      parent_id: formData.parentId || null,
      attribute_ids: attributeIds.length > 0 ? attributeIds : [],
      attribute_mp_links: attributeMpLinks,
      mp_field_links: dedicatedMpLinks,
      skip_marketplace_stock_sync: formData.skip_marketplace_stock_sync === true,
      marketplaceMappings: {
        wb: wbCategoryId && !isNaN(wbCategoryId) && wbCategoryId > 0 ? wbCategoryId : null,
        ozon: ozonCategoryId || null,
        ...(ozonDisplay ? { ozon_display: ozonDisplay } : {}),
        ...(ozonDescId != null && ozonTypeId != null && ozonTypeId > 0
          ? { ozon_description_category_id: ozonDescId, ozon_type_id: ozonTypeId }
          : {}),
        ym: ymCategoryId && !isNaN(ymCategoryId) && ymCategoryId > 0 ? ymCategoryId : null,
        ...(ymDisplay ? { ym_display: ymDisplay } : {}),
      }
    };

    console.log('[CategoryForm] Submitting payload:', payload);
    console.log('[CategoryForm] Category IDs:', {
      wbCategoryId: formData.wbCategoryId,
      wbCategoryIdParsed: wbCategoryId,
      wbCategoryIdType: typeof wbCategoryId,
      ozonCategoryId: formData.ozonCategoryId,
      ozonCategoryIdParsed: ozonCategoryId,
      ozonCategoryIdType: typeof ozonCategoryId
    });

    // Передаем данные в onSubmit, который сохранит категорию и маппинги
    await onSubmit(payload);
  };

  // Фильтруем категории, исключая текущую (при редактировании)
  const availableCategories = categories.filter(cat => !category || cat.id !== category.id);

  return (
    <form className="category-form" onSubmit={handleSubmit}>
      <div className="field">
        <label className="label" htmlFor="categoryName">
          Название категории <span style={{color: '#ef4444'}}>*</span>
        </label>
        <input
          id="categoryName"
          type="text"
          className="form-control form-control-sm"
          placeholder="Введите название категории"
          value={formData.name}
          onChange={(e) => handleChange('name', e.target.value)}
          required
        />
        {errors.name && <div className="error">{errors.name}</div>}
      </div>

      <div className="field">
        <div className="form-check form-switch mb-0">
          <input
            className="form-check-input"
            type="checkbox"
            role="switch"
            id="categorySkipMpStock"
            checked={formData.skip_marketplace_stock_sync === true}
            onChange={(e) => handleChange('skip_marketplace_stock_sync', e.target.checked)}
          />
          <label className="form-check-label" htmlFor="categorySkipMpStock">
            Не передавать остатки на маркетплейс
          </label>
        </div>
        <p className="text-muted small mt-1 mb-0">
          При включении остатки товаров этой категории не отправляются на Ozon, Wildberries и Яндекс.Маркет.
          Для дочерних категорий учитывается также настройка родительской категории.
          Импорт остатков с маркетплейсов и другие операции не затрагиваются.
        </p>
      </div>

      <div className="field">
        <label className="label" htmlFor="categoryParent">Родительская категория</label>
        <select
          id="categoryParent"
          className="form-select form-select-sm"
          value={formData.parentId}
          onChange={(e) => handleChange('parentId', e.target.value)}
        >
          <option value="">Без родительской категории</option>
          {availableCategories
            .filter(cat => !cat.parent_id && !cat.parentId) // Только родительские категории
            .map(cat => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
        </select>
      </div>

      <div className="field" style={{ marginTop: '16px' }}>
        <label className="label">Атрибуты на вкладке «Основное»</label>
        <p style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '8px' }}>
          Добавьте нужное поле или атрибут, затем прикрепите к нему характеристики Ozon / WB / Яндекс.Маркета.
          К одному полю можно привязать несколько характеристик одного маркетплейса. Списки характеристик появятся после сопоставления категорий ниже.
        </p>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
          <select
            id="categoryAttributesSelect"
            className="form-select form-select-sm"
            value={pickerValue}
            onChange={(e) => setPickerValue(e.target.value)}
            style={{ flex: 1, maxWidth: '320px' }}
          >
            <option value="">Поле или атрибут…</option>
            {DEDICATED_MAIN_MAP_KEYS.filter((key) => !addedDedicatedKeys.includes(key)).length > 0 ? (
              <optgroup label="Поля вкладки «Основное»">
                {DEDICATED_MAIN_MAP_KEYS
                  .filter((key) => !addedDedicatedKeys.includes(key))
                  .slice()
                  .sort((a, b) =>
                    String(MP_FIELD_LINK_FIELD_LABELS[a] || a).localeCompare(
                      String(MP_FIELD_LINK_FIELD_LABELS[b] || b),
                      'ru',
                      { sensitivity: 'base' }
                    )
                  )
                  .map((key) => (
                    <option key={`main:${key}`} value={`main:${key}`}>
                      {MP_FIELD_LINK_FIELD_LABELS[key] || key}
                    </option>
                  ))}
              </optgroup>
            ) : null}
            {allAttributes.filter((attr) => !attributeIds.includes(String(attr.id))).length > 0 ? (
              <optgroup label="Свои атрибуты">
                {allAttributes
                  .filter((attr) => !attributeIds.includes(String(attr.id)))
                  .slice()
                  .sort((a, b) =>
                    String(a.name || '').localeCompare(String(b.name || ''), 'ru', { sensitivity: 'base' })
                  )
                  .map((attr) => (
                    <option key={`attr:${attr.id}`} value={`attr:${attr.id}`}>
                      {attr.name}
                    </option>
                  ))}
              </optgroup>
            ) : null}
          </select>
          <Button
            type="button"
            variant="secondary"
            size="small"
            onClick={() => {
              if (!pickerValue) return;
              if (pickerValue.startsWith('main:')) {
                const key = pickerValue.slice(5);
                if (!DEDICATED_MAIN_MAP_KEYS.includes(key)) return;
                setAddedDedicatedKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
                setDedicatedMpLinks((prev) => ({
                  ...prev,
                  [key]: prev[key] && attrMpLinksHasAny(prev[key]) ? prev[key] : emptyAttrMpLinks(),
                }));
                setPickerValue('');
                return;
              }
              if (pickerValue.startsWith('attr:')) {
                const id = pickerValue.slice(5);
                if (!id) return;
                setAttributeIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
                setAttributeMpLinks((prev) => {
                  if (prev[id] && attrMpLinksHasAny(prev[id])) return prev;
                  return { ...prev, [id]: emptyAttrMpLinks() };
                });
                setPickerValue('');
              }
            }}
            disabled={!pickerValue}
          >
            Добавить
          </Button>
        </div>
        {allAttributes.length === 0 ? (
          <p style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '8px' }}>
            Свои атрибуты создаются в «Настройки → Атрибуты».
          </p>
        ) : null}
        {!formData.ozonCategoryId && !formData.wbCategoryId && !formData.ymCategoryId && (
          <p style={{ fontSize: '12px', color: '#b45309', marginBottom: '8px' }}>
            Списки характеристик появятся после сопоставления с маркетплейсами ниже. Можно вписать название вручную.
          </p>
        )}
        {addedDedicatedKeys.length === 0 && attributeIds.length === 0 ? (
          <span style={{ fontSize: '12px', color: 'var(--muted)' }}>Ничего не добавлено</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {addedDedicatedKeys.map((key) => (
              <div
                key={`dedicated-${key}`}
                style={{
                  padding: '12px',
                  border: '1px solid var(--border, #e5e7eb)',
                  borderRadius: '8px',
                  background: '#fff',
                }}
              >
                <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                  {MP_FIELD_LINK_FIELD_LABELS[key] || key}
                  <MpMappedMpBadges mps={mappedMpsFromAttrLinks(dedicatedMpLinks[key])} size={18} />
                  <button
                    type="button"
                    onClick={() => {
                      setAddedDedicatedKeys((prev) => prev.filter((x) => x !== key));
                      setDedicatedMpLinks((prev) => ({ ...prev, [key]: emptyAttrMpLinks() }));
                    }}
                    aria-label="Удалить"
                    style={{
                      marginLeft: 'auto',
                      padding: '0 4px',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--muted, #6b7280)',
                      fontSize: '16px',
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </div>
                <AttributeMpLinkFields
                  links={dedicatedMpLinks[key] || emptyAttrMpLinks()}
                  onChange={(next) => setDedicatedMpLinks((prev) => ({ ...prev, [key]: next }))}
                  ozonOptions={ozonMpAttrs}
                  wbOptions={wbMpAttrs}
                  ymOptions={ymMpAttrs}
                  getWbId={wbAttrKey}
                  getWbName={wbAttrName}
                />
              </div>
            ))}
            {attributeIds.map((id) => {
              const attr = allAttributes.find((a) => String(a.id) === id);
              return (
                <div
                  key={`mp-${id}`}
                  style={{
                    padding: '12px',
                    border: '1px solid var(--border, #e5e7eb)',
                    borderRadius: '8px',
                    background: '#fff',
                  }}
                >
                  <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                    {attr?.name || id}
                    <MpMappedMpBadges mps={mappedMpsFromAttrLinks(attributeMpLinks[id])} size={18} />
                    <button
                      type="button"
                      onClick={() => {
                        setAttributeIds((prev) => prev.filter((x) => x !== id));
                        setAttributeMpLinks((prev) => {
                          const next = { ...prev };
                          delete next[id];
                          return next;
                        });
                      }}
                      aria-label="Удалить"
                      style={{
                        marginLeft: 'auto',
                        padding: '0 4px',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'var(--muted, #6b7280)',
                        fontSize: '16px',
                        lineHeight: 1,
                      }}
                    >
                      ×
                    </button>
                  </div>
                  <AttributeMpLinkFields
                    links={attributeMpLinks[id] || emptyAttrMpLinks()}
                    onChange={(next) => setAttributeMpLinks((prev) => ({ ...prev, [id]: next }))}
                    ozonOptions={ozonMpAttrs}
                    wbOptions={wbMpAttrs}
                    ymOptions={ymMpAttrs}
                    getWbId={wbAttrKey}
                    getWbName={wbAttrName}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="field" style={{ marginTop: '16px' }}>
        <label className="label">Rich-контент</label>
        {category?.id ? (
          <>
            <p style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '8px' }}>
              Шаблон собирается из модулей отдельно для каждой категории.
            </p>
            <div className="d-flex flex-wrap gap-2">
              <Link
                to={`/products/rich-content?categoryId=${encodeURIComponent(category.id)}`}
                className="btn btn-secondary btn-sm"
              >
                Шаблон этой категории
              </Link>
            </div>
          </>
        ) : (
          <p style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: 0 }}>
            Сохраните категорию, чтобы настроить шаблон Rich-контента.
          </p>
        )}
      </div>

      {/* Сопоставление с маркетплейсами */}
      <div style={{marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border)'}}>
        <h4 style={{fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: 'var(--text)'}}>
          🏪 Сопоставление с маркетплейсами
        </h4>
        <p style={{fontSize: '12px', color: 'var(--muted)', marginBottom: '16px'}}>
          Сопоставления применяются ко всем товарам категории. Нажмите «Изменить» или «Выбрать» для выбора категории маркетплейса.
        </p>

        {renderMpSummaryRow('wb', 'wb', 'Wildberries', formData.wbCategoryId)}
        {renderMpSummaryRow('ozon', 'ozon', 'Ozon', formData.ozonCategoryId)}
        {renderMpSummaryRow('ym', 'ym', 'Яндекс.Маркет', formData.ymCategoryId)}

        {(formData.ozonCategoryId || formData.ymCategoryId) && (
          <div style={{ marginBottom: '12px' }}>
            <button
              type="button"
              onClick={handleRefreshMpCommissions}
              disabled={mpCommissionsRefreshing}
              style={{ fontSize: '11px', padding: '2px 8px', cursor: mpCommissionsRefreshing ? 'not-allowed' : 'pointer' }}
            >
              {mpCommissionsRefreshing ? 'Обновление комиссий…' : 'Обновить комиссии Ozon/YM из API'}
            </button>
          </div>
        )}

        {editingMpMapping === 'wb' && (
        <div className="field" style={{marginBottom: '12px', position: 'relative'}}>
          <label className="label" htmlFor="wbCategory" style={{fontSize: '12px'}}>
            <span style={{display: 'inline-flex', alignItems: 'center', gap: '4px'}}>
              <span className="mp-badge wb">WB</span>
              Wildberries — выбор категории
            </span>
            <button
              type="button"
              onClick={async () => {
                setWbRefreshing(true);
                setWbRefreshError('');
                try {
                  const updateRes = await integrationsApi.updateWildberriesCategories();
                  const payload = updateRes?.data ?? updateRes;
                  if (updateRes?.ok === false || payload?.skipped || payload?.success === false) {
                    throw new Error(
                      updateRes?.error ||
                        (payload?.message === 'WB API key not configured'
                          ? 'API-ключ Wildberries не найден. Проверьте кабинет WB в Интеграции → Маркетплейсы (для выбранной организации).'
                          : (payload?.message || 'Не удалось обновить категории WB'))
                    );
                  }
                  const res = await integrationsApi.getWildberriesCategories();
                  const formatted = formatWbCategoryList(res?.data ?? res);
                  if (onRefreshWbCategories) onRefreshWbCategories(formatted);
                  else setMarketplaceCategories((prev) => ({ ...prev, wb: formatted }));
                } catch (e) {
                  console.error('[CategoryForm] WB refresh failed:', e);
                  const msg = e?.response?.data?.error || e?.response?.data?.message || e?.message || 'Ошибка обновления категорий WB';
                  setWbRefreshError(msg);
                } finally {
                  setWbRefreshing(false);
                }
              }}
              disabled={wbRefreshing}
              style={{ marginLeft: '8px', fontSize: '11px', padding: '2px 8px', cursor: wbRefreshing ? 'not-allowed' : 'pointer', opacity: wbRefreshing ? 0.7 : 1 }}
            >
              {wbRefreshing ? 'Загрузка…' : (effective.wb.length > 0 ? 'Обновить список' : 'Загрузить список категорий')}
            </button>
          </label>
          <p style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px', marginBottom: '6px' }}>
            Список подтягивается из API WB (категории и комиссии). Автообновление — раз в сутки около 1:00 МСК.
          </p>
          {wbRefreshError && (
            <p style={{ fontSize: '11px', color: 'var(--error, #dc2626)', marginBottom: '6px' }}>{wbRefreshError}</p>
          )}
          {loading.wb ? (
            <div style={{padding: '8px', color: 'var(--muted)', fontSize: '12px'}}>Загрузка категорий...</div>
          ) : (
            <div style={{position: 'relative'}}>
              <div style={{display: 'flex', gap: '8px', alignItems: 'center'}}>
                <div style={{flex: 1, position: 'relative'}}>
                  <input
                    id="wbCategory"
                    type="text"
                    className="form-control form-control-sm"
                    placeholder="Начните вводить название категории..."
                    value={wbSearchQuery}
                    onChange={(e) => {
                      const q = e.target.value;
                      setWbSearchQuery(q);
                      setWbDropdownOpen(true);
                      if (!q.trim()) {
                        setWbSelectedCategory(null);
                        handleChange('wbCategoryId', '');
                      }
                    }}
                    onFocus={() => setWbDropdownOpen(true)}
                    onBlur={() => setTimeout(() => setWbDropdownOpen(false), 200)}
                    autoComplete="off"
                    style={{ background: '#fff', color: '#1a1a1a', caretColor: '#1a1a1a' }}
                  />
                  {wbDropdownOpen && (
                    <div style={{
                      position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 1000,
                      background: '#fff', border: '1px solid #e5e7eb', borderRadius: '6px',
                      maxHeight: '200px', overflowY: 'auto', marginTop: '4px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                    }}>
                      {!wbSearchQuery.trim() ? (
                        <div style={{padding: '12px', textAlign: 'center', color: '#6b7280', fontSize: '12px'}}>
                          Начните вводить название категории
                        </div>
                      ) : (
                        (() => {
                          const q = wbSearchQuery.toLowerCase();
                          const list = effective.wb.filter(c => {
                            const n = (c.name || '').toLowerCase();
                            const p = (c.parent_name || '').toLowerCase();
                            return n.includes(q) || p.includes(q);
                          }).slice(0, 20);
                          if (!list.length) {
                            return <div style={{padding: '12px', textAlign: 'center', color: '#6b7280', fontSize: '12px'}}>Ничего не найдено</div>;
                          }
                          return list.map(cat => (
                            <div
                              key={cat.id}
                              style={{
                                padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6',
                                background: wbSelectedCategory?.id === cat.id ? '#f3f4f6' : '#fff', color: '#1a1a1a'
                              }}
                              onMouseDown={(e) => { e.preventDefault(); setWbSelectedCategory(cat); setWbSearchQuery(cat.name || ''); handleChange('wbCategoryId', String(cat.id)); setWbDropdownOpen(false); closeMpEdit(); }}
                            >
                              <div style={{fontSize: '13px', fontWeight: 500}}>{cat.name}</div>
                              {cat.parent_name && <div style={{fontSize: '11px', color: '#6b7280', marginTop: '2px'}}>{cat.parent_name}</div>}
                            </div>
                          ));
                        })()
                      )}
                    </div>
                  )}
                </div>
                {wbSelectedCategory && (
                  <button
                    type="button"
                    onClick={() => { setWbSelectedCategory(null); setWbSearchQuery(''); handleChange('wbCategoryId', ''); }}
                    style={{ padding: '6px 12px', background: 'transparent', border: '1px solid #e5e7eb', borderRadius: '4px', cursor: 'pointer', color: '#6b7280', fontSize: '12px' }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        )}

        {editingMpMapping === 'ozon' && (
        <div className="field" style={{marginBottom: '12px', position: 'relative'}}>
          <label className="label" htmlFor="ozonCategory" style={{fontSize: '12px'}}>
            <span style={{display: 'inline-flex', alignItems: 'center', gap: '4px'}}>
              <span className="mp-badge ozon">OZ</span>
              Ozon — выбор категории
            </span>
            {(
              <button
                type="button"
                onClick={async () => {
                  setOzonRefreshing(true);
                  try {
                    const res = await integrationsApi.getOzonCategories({ forceRefresh: true });
                    const raw = res?.data || res || [];
                    const formatted = raw.map(cat => ({
                      id: cat.id,
                      name: cat.name,
                      path: cat.path,
                      marketplace_category_id: cat.id,
                      marketplace: 'ozon',
                      parent_id: cat.parent_id,
                      disabled: cat.disabled
                    }));
                    if (onRefreshOzonCategories) onRefreshOzonCategories(formatted);
                    else setMarketplaceCategories(prev => ({ ...prev, ozon: formatted }));
                  } catch (e) {
                    console.error('[CategoryForm] Ozon refresh failed:', e);
                  } finally {
                    setOzonRefreshing(false);
                  }
                }}
                disabled={ozonRefreshing}
                style={{ marginLeft: '8px', fontSize: '11px', padding: '2px 8px', cursor: ozonRefreshing ? 'not-allowed' : 'pointer', opacity: ozonRefreshing ? 0.7 : 1 }}
              >
                {ozonRefreshing ? 'Загрузка…' : (effective.ozon.length > 0 ? 'Обновить список' : 'Загрузить список категорий')}
              </button>
            )}
          </label>
          <p style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px', marginBottom: '6px' }}>
            Для атрибутов Ozon в карточке товара выберите <strong>тип товара</strong> — пункт с путём вида «Категория › Тип товара» (не только категорию).
          </p>
          {loading.ozon ? (
            <div style={{padding: '8px', color: 'var(--muted)', fontSize: '12px'}}>Загрузка категорий...</div>
          ) : (
            <div style={{position: 'relative'}}>
              <div style={{display: 'flex', gap: '8px', alignItems: 'center'}}>
                <div style={{flex: 1, position: 'relative'}}>
                  <input
                    id="ozonCategory"
                    type="text"
                    className="form-control form-control-sm"
                    placeholder="Начните вводить название категории..."
                    value={ozonSearchQuery}
                    onChange={(e) => {
                      const query = e.target.value;
                      setOzonSearchQuery(query);
                      setOzonDropdownOpen(true);
                      if (!query.trim()) {
                        setOzonSelectedCategory(null);
                        handleChange('ozonCategoryId', '');
                      }
                    }}
                    onFocus={() => setOzonDropdownOpen(true)}
                    onBlur={() => {
                      setTimeout(() => setOzonDropdownOpen(false), 200);
                    }}
                    autoComplete="off"
                    style={{
                      background: '#fff',
                      color: '#1a1a1a',
                      caretColor: '#1a1a1a'
                    }}
                  />
                  {ozonDropdownOpen && (
                    <div style={{
                      position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 1000,
                      background: '#fff', border: '1px solid #e5e7eb', borderRadius: '6px',
                      maxHeight: '200px', overflowY: 'auto', marginTop: '4px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                    }}>
                      {(() => {
                        if (!ozonSearchQuery.trim()) {
                          return (
                            <div style={{padding: '12px', textAlign: 'center', color: '#6b7280', fontSize: '12px'}}>
                              Начните вводить название категории
                            </div>
                          );
                        }
                        const searchLower = ozonSearchQuery.toLowerCase();
                        const filtered = effective.ozon.filter(cat => {
                          const name = (cat.name || '').toLowerCase();
                          const path = (cat.path || '').toLowerCase();
                          return name.includes(searchLower) || path.includes(searchLower);
                        }).slice(0, 20);
                        if (filtered.length === 0) {
                          return (
                            <div style={{padding: '12px', textAlign: 'center', color: '#6b7280', fontSize: '12px'}}>
                              Ничего не найдено
                            </div>
                          );
                        }
                        return filtered.map(cat => (
                          <div
                            key={cat.id}
                            style={{
                              padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6',
                              background: ozonSelectedCategory?.id === cat.id ? '#f3f4f6' : '#fff', color: '#1a1a1a'
                            }}
                            onMouseDown={(e) => {
                              e.preventDefault(); // Предотвращаем blur
                              setOzonSelectedCategory(cat);
                              const isType = String(cat.id || '').includes('_');
                              setOzonSearchQuery(isType && cat.path ? cat.path : (cat.name || ''));
                              handleChange('ozonCategoryId', cat.id);
                              setOzonDropdownOpen(false);
                              closeMpEdit();
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = '#f3f4f6'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = ozonSelectedCategory?.id === cat.id ? '#f3f4f6' : '#fff'; }}
                          >
                            {String(cat.id || '').includes('_') ? (
                              <>
                                <div style={{ fontSize: '13px', fontWeight: 500 }}>{cat.path || cat.name}</div>
                                <div style={{ fontSize: '10px', color: '#005bff', marginTop: '2px' }}>Тип товара — для атрибутов Ozon</div>
                              </>
                            ) : (
                              <>
                                <div style={{fontSize: '13px', fontWeight: 500}}>{cat.name}</div>
                                {cat.path && cat.path !== cat.name && (
                                  <div style={{fontSize: '11px', color: '#6b7280', marginTop: '2px'}}>{cat.path}</div>
                                )}
                              </>
                            )}
                          </div>
                        ));
                      })()}
                    </div>
                  )}
                </div>
                {ozonSelectedCategory && (
                  <button
                    type="button"
                    onClick={() => { setOzonSelectedCategory(null); setOzonSearchQuery(''); handleChange('ozonCategoryId', ''); }}
                    style={{ padding: '6px 12px', background: 'transparent', border: '1px solid #e5e7eb', borderRadius: '4px', cursor: 'pointer', color: '#6b7280', fontSize: '12px' }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        )}

        {editingMpMapping === 'ym' && (
        <div className="field" style={{marginBottom: '12px', position: 'relative'}}>
          <label className="label" htmlFor="ymCategory" style={{fontSize: '12px'}}>
            <span style={{display: 'inline-flex', alignItems: 'center', gap: '4px'}}>
              <span className="mp-badge ym">YM</span>
              Яндекс.Маркет — выбор категории
            </span>
          </label>
          {loading.ym ? (
            <div style={{padding: '8px', color: '#6b7280', fontSize: '12px'}}>Загрузка категорий...</div>
          ) : (
            <div style={{position: 'relative'}}>
              <div style={{display: 'flex', gap: '8px', alignItems: 'center'}}>
                <div style={{flex: 1, position: 'relative'}}>
                  <input
                    id="ymCategory"
                    type="text"
                    className="form-control form-control-sm"
                    placeholder="Начните вводить название категории..."
                    value={ymSearchQuery}
                    onChange={(e) => {
                      const q = e.target.value;
                      setYmSearchQuery(q);
                      setYmDropdownOpen(true);
                      if (!q.trim()) {
                        setYmSelectedCategory(null);
                        handleChange('ymCategoryId', '');
                      }
                    }}
                    onFocus={() => setYmDropdownOpen(true)}
                    onBlur={() => setTimeout(() => setYmDropdownOpen(false), 200)}
                    autoComplete="off"
                    style={{ background: '#fff', color: '#1a1a1a', caretColor: '#1a1a1a' }}
                  />
                  {ymDropdownOpen && (
                    <div style={{
                      position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 1000,
                      background: '#fff', border: '1px solid #e5e7eb', borderRadius: '6px',
                      maxHeight: '200px', overflowY: 'auto', marginTop: '4px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                    }}>
                      {!ymSearchQuery.trim() ? (
                        <div style={{padding: '12px', textAlign: 'center', color: '#6b7280', fontSize: '12px'}}>
                          Начните вводить название категории
                        </div>
                      ) : (
                        (() => {
                          const q = ymSearchQuery.toLowerCase();
                          const list = effective.ym.filter(c => {
                            const n = (c.name || '').toLowerCase();
                            const p = (c.path || c.parent_name || '').toLowerCase();
                            return n.includes(q) || p.includes(q);
                          }).slice(0, 20);
                          if (!list.length) {
                            return <div style={{padding: '12px', textAlign: 'center', color: '#6b7280', fontSize: '12px'}}>Ничего не найдено</div>;
                          }
                          return list.map(cat => (
                            <div
                              key={cat.id}
                              style={{
                                padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6',
                                background: ymSelectedCategory?.id === cat.id ? '#f3f4f6' : '#fff', color: '#1a1a1a'
                              }}
                              onMouseDown={(e) => { e.preventDefault(); setYmSelectedCategory(cat); setYmSearchQuery(cat.name || ''); handleChange('ymCategoryId', String(cat.id)); setYmDropdownOpen(false); closeMpEdit(); }}
                            >
                              <div style={{fontSize: '13px', fontWeight: 500}}>{cat.name}</div>
                              {cat.path && cat.path !== cat.name && <div style={{fontSize: '11px', color: '#6b7280', marginTop: '2px'}}>{cat.path}</div>}
                            </div>
                          ));
                        })()
                      )}
                    </div>
                  )}
                </div>
                {ymSelectedCategory && (
                  <button
                    type="button"
                    onClick={() => { setYmSelectedCategory(null); setYmSearchQuery(''); handleChange('ymCategoryId', ''); }}
                    style={{ padding: '6px 12px', background: 'transparent', border: '1px solid #e5e7eb', borderRadius: '4px', cursor: 'pointer', color: '#6b7280', fontSize: '12px' }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        )}
      </div>

      {Object.keys(errors).length > 0 && (
        <div className="error" style={{marginTop: '12px'}}>
          {Object.values(errors)[0]}
        </div>
      )}

      <div className="d-flex justify-content-end gap-2 mt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>Отмена</Button>
        <Button type="submit" variant="primary">{category ? 'Сохранить' : 'Добавить категорию'}</Button>
      </div>
    </form>
  );
}

