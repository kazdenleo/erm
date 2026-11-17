/**
 * Вкладка «Из парсера»: ZIP или папка (Excel + папки фото по артикулам) → создание товаров.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { useBrands } from '../../hooks/useBrands';
import { useCategories } from '../../hooks/useCategories';
import { useOrganizations } from '../../hooks/useOrganizations';
import { productAttributesApi } from '../../services/productAttributes.api.js';
import { productsApi } from '../../services/products.api.js';
import { pickSingleEntityId } from '../../utils/stockDestinationDefaults.js';

function rowKey(row) {
  return `${row.index}-${row.sku || ''}`;
}

const MAIN_FIELD_TARGETS = [
  { id: 'main:sku', key: 'sku', name: 'Артикул', group: 'Основное' },
  { id: 'main:name', key: 'name', name: 'Название', group: 'Основное' },
  { id: 'main:brand', key: 'brand', name: 'Бренд', group: 'Основное' },
  { id: 'main:description', key: 'description', name: 'Описание', group: 'Основное' },
  { id: 'main:applicability', key: 'applicability', name: 'Применимость', group: 'Основное' },
  { id: 'main:analogs', key: 'analogs', name: 'Аналоги', group: 'Основное' },
  { id: 'main:country', key: 'country', name: 'Страна', group: 'Основное' },
];

const EMPTY_FIELD_MAPPINGS = () => ({});

function normCol(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function asColumnList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null || value === '') return [];
  return [String(value)].filter(Boolean);
}

/** Значение из raw по сопоставленным столбцам (как на сервере). */
function resolveRawMapped(raw, cols, { multiline = false } = {}) {
  const list = asColumnList(cols);
  const parts = [];
  for (const c of list) {
    const v = String(raw?.[c] ?? '').trim();
    if (v) parts.push(v);
  }
  if (!parts.length) return '';
  return multiline ? parts.join('\n') : parts.join('. ');
}

function mappingFromFieldMappings(fieldMappings) {
  const mapping = {
    sku: [],
    name: [],
    brand: [],
    description: [],
    country: [],
    applicability: [],
    analogs: [],
  };
  const attributeMappings = {};
  for (const [id, cols] of Object.entries(fieldMappings || {})) {
    const list = asColumnList(cols);
    if (!list.length) continue;
    if (id.startsWith('main:')) {
      const key = id.slice(5);
      if (Object.prototype.hasOwnProperty.call(mapping, key)) mapping[key] = list;
      continue;
    }
    if (id.startsWith('attr:')) {
      attributeMappings[id.slice(5)] = list;
    }
  }
  return { mapping, attributeMappings };
}

/**
 * Несколько столбцов → одно поле/атрибут (на сервере: перенос для editable, «. » для однострочных).
 * Выпадающий список + чипы. Столбцы, уже занятые другим полем, — другим цветом.
 * @param {Map<string, string[]>} [columnOwners] col → список владельцев
 * @param {string} [ownerLabel] метка текущего поля (чтобы не считать себя «чужим»)
 */
function ColumnMultiSelect({
  label,
  value,
  columns,
  onChange,
  emptyLabel = '—',
  columnOwners,
  ownerLabel,
  compact = false,
}) {
  const selected = asColumnList(value);
  const allCols = Array.isArray(columns) ? columns.map(String).filter(Boolean) : [];
  const unused = allCols.filter((c) => !selected.includes(c));
  const selfLabel = ownerLabel || label || '';

  const otherOwners = (col) => {
    const list = columnOwners?.get?.(col) || columnOwners?.get?.(String(col)) || [];
    return list.filter((o) => o && o !== selfLabel);
  };

  const setSelected = (next) => {
    const cleaned = [];
    for (const c of next) {
      const s = String(c || '');
      if (!s || cleaned.includes(s)) continue;
      cleaned.push(s);
    }
    onChange(cleaned);
  };

  return (
    <div
      className={`small catalog-bundle-attr-multi${compact ? ' is-compact' : ''}`}
    >
      {label ? <div className="catalog-bundle-attr-label">{label}</div> : null}
      <div className="catalog-bundle-attr-inline">
        {selected.map((col) => {
          const others = otherOwners(col);
          return (
            <span
              key={`${selfLabel || 'col'}-chip-${col}`}
              className={`catalog-bundle-attr-chip${others.length ? ' is-shared' : ''}`}
              title={others.length ? `Также: ${others.join(', ')}` : undefined}
            >
              <span className="catalog-bundle-attr-chip-text">{col}</span>
              <button
                type="button"
                className="catalog-bundle-attr-chip-x"
                onClick={() => setSelected(selected.filter((c) => c !== col))}
                title="Убрать"
                aria-label={`Убрать ${col}`}
              >
                ×
              </button>
            </span>
          );
        })}
        <select
          className="form-control form-control-sm catalog-bundle-col-select"
          value=""
          disabled={!unused.length}
          onChange={(e) => {
            const col = e.target.value;
            if (!col) return;
            setSelected([...selected, col]);
          }}
          aria-label={
            selected.length
              ? `${selfLabel || 'поле'}: добавить столбец`
              : `${selfLabel || 'поле'}: выбрать столбец`
          }
        >
          <option value="">
            {!allCols.length
              ? 'Нет столбцов'
              : !unused.length
                ? 'Все выбраны'
                : selected.length
                  ? '+ столбец'
                  : emptyLabel}
          </option>
          {unused.map((c) => {
            const others = otherOwners(c);
            const taken = others.length > 0;
            return (
              <option
                key={`${selfLabel || 'col'}-add-${c}`}
                value={c}
                className={taken ? 'catalog-bundle-col-taken' : undefined}
                style={taken ? { color: '#b45309', fontWeight: 600 } : undefined}
              >
                {taken ? `${c} · уже: ${others.join(', ')}` : c}
              </option>
            );
          })}
        </select>
      </div>
    </div>
  );
}

/**
 * Строки сопоставления: название атрибута | столбцы рядом.
 * Ниже — добавить новую связь.
 */
function AttributeMappingPicker({ targets, columns, value, onChange, columnOwners }) {
  const byId = useMemo(() => {
    const m = new Map();
    for (const t of targets || []) m.set(String(t.id), t);
    return m;
  }, [targets]);

  const displayRows = useMemo(() => {
    // Порядок = порядок добавления (новое сопоставление — внизу)
    const rows = [];
    for (const [tid, cols] of Object.entries(value || {})) {
      if (!Object.prototype.hasOwnProperty.call(value, tid)) continue;
      const t = byId.get(String(tid));
      if (!t) continue;
      rows.push({
        id: String(tid),
        name: t.name,
        group: t.group || '',
        cols: asColumnList(cols),
      });
    }
    return rows;
  }, [value, byId]);

  const availableGrouped = useMemo(() => {
    const taken = new Set(displayRows.map((r) => r.id));
    const groups = new Map();
    for (const t of targets || []) {
      if (!t?.id) continue;
      if (taken.has(String(t.id))) continue;
      const g = t.group || 'Прочее';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'));
    }
    const order = ['Основное', 'Категория', 'Общие', 'Прочее'];
    return order
      .filter((g) => groups.has(g) && groups.get(g).length)
      .map((g) => ({ group: g, items: groups.get(g) }));
  }, [targets, displayRows]);

  const setCols = (tid, cols) => {
    onChange((prev) => {
      const next = { ...(prev || {}) };
      next[String(tid)] = asColumnList(cols);
      return next;
    });
  };

  const addLink = (tid) => {
    if (!tid) return;
    onChange((prev) => {
      const next = { ...(prev || {}) };
      if (!Object.prototype.hasOwnProperty.call(next, tid)) next[tid] = [];
      return next;
    });
  };

  const removeLink = (tid) => {
    onChange((prev) => {
      const next = { ...(prev || {}) };
      delete next[String(tid)];
      return next;
    });
  };

  return (
    <div className="catalog-bundle-attr-picker">
      <div className="catalog-bundle-map-rows">
        {displayRows.map((row) => (
          <div key={row.id} className="catalog-bundle-map-row">
            <div className="catalog-bundle-map-row-name" title={row.group || undefined}>
              {row.name}
            </div>
            <div className="catalog-bundle-map-row-cols">
              <ColumnMultiSelect
                compact
                value={(value && value[row.id]) || []}
                columns={columns}
                ownerLabel={row.name}
                columnOwners={columnOwners}
                emptyLabel="— столбец —"
                onChange={(cols) => setCols(row.id, cols)}
              />
            </div>
            <button
              type="button"
              className="btn btn-sm btn-light catalog-bundle-map-row-remove"
              onClick={() => removeLink(row.id)}
              aria-label={`Убрать ${row.name}`}
              title="Убрать связь"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {availableGrouped.length > 0 ? (
        <div className="catalog-bundle-map-add">
          <select
            className="form-control form-control-sm"
            value=""
            onChange={(e) => {
              const tid = e.target.value;
              if (tid) addLink(tid);
            }}
            aria-label="Добавить сопоставление"
          >
            <option value="">+ Добавить сопоставление…</option>
            {availableGrouped.map(({ group, items }) => (
              <optgroup key={group} label={group}>
                {items.map((t) => (
                  <option key={t.id} value={String(t.id)}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}

const DIM_SYSTEM_KEYS = new Set([
  'product_length',
  'product_width',
  'product_height',
  'product_weight',
  'length',
  'width',
  'height',
  'weight',
]);

function suggestAttributeMappings(columns, attrs) {
  const out = {};
  const cols = Array.isArray(columns) ? columns : [];
  for (const attr of attrs || []) {
    if (!attr?.id || !attr?.name) continue;
    // Габариты не подставляем сами — иначе в карточку уезжают «размеры упаковки по умолчанию»
    const sk = String(attr.system_key ?? attr.systemKey ?? '').trim();
    if (sk && DIM_SYSTEM_KEYS.has(sk)) continue;
    const want = normCol(attr.name);
    if (!want) continue;
    const hit = cols.find((c) => normCol(c) === want);
    if (hit) out[String(attr.id)] = [hit];
  }
  return out;
}

export function CatalogBundleImportPanel() {
  const zipRef = useRef(null);
  const folderRef = useRef(null);
  const { brands } = useBrands();
  const { categories } = useCategories();
  const { organizations } = useOrganizations();
  const singleOrganizationId = useMemo(
    () => pickSingleEntityId(organizations),
    [organizations]
  );

  useEffect(() => {
    const el = folderRef.current;
    if (!el) return;
    el.setAttribute('webkitdirectory', '');
    el.setAttribute('directory', '');
  }, []);

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [columns, setColumns] = useState([]);
  const [fieldMappings, setFieldMappings] = useState(() => EMPTY_FIELD_MAPPINGS());
  const [allAttributes, setAllAttributes] = useState([]);
  const [rows, setRows] = useState([]);
  const [defaults, setDefaults] = useState({
    categoryId: '',
    organizationId: '',
    brandId: '',
    countryOfOrigin: '',
  });
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState('');
  const [createError, setCreateError] = useState('');
  const [proposalModal, setProposalModal] = useState({ open: false, items: [] });
  const [applyingProposals, setApplyingProposals] = useState(false);

  useEffect(() => {
    let cancelled = false;
    productAttributesApi
      .getAll()
      .then((res) => {
        if (cancelled) return;
        const list = res?.data ?? (Array.isArray(res) ? res : []);
        setAllAttributes(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setAllAttributes([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedCategory = useMemo(() => {
    const cid = String(defaults.categoryId || '');
    if (!cid) return null;
    return (categories || []).find((c) => String(c.id) === cid) || null;
  }, [categories, defaults.categoryId]);

  const categoryAttrIds = useMemo(
    () => new Set((selectedCategory?.attribute_ids || []).map((x) => String(x))),
    [selectedCategory]
  );

  /** Свои атрибуты категории + остальные/габариты (без дублей основного) */
  const extraAttrTargets = useMemo(() => {
    const dimKeys = new Set([
      'product_length',
      'product_width',
      'product_height',
      'product_weight',
      'length',
      'width',
      'height',
      'weight',
    ]);
    const mainNames = new Set(
      MAIN_FIELD_TARGETS.map((t) => normCol(t.name))
    );
    const skipSystemMain = new Set([
      'sku',
      'name',
      'brand',
      'description',
      'country',
    ]);
    const out = [];
    for (const a of allAttributes || []) {
      if (!a?.id || !a?.name) continue;
      const systemKey = String(a.system_key ?? a.systemKey ?? '').trim();
      const n = normCol(a.name);
      if (mainNames.has(n)) continue; // уже в «Основное»
      if (systemKey && skipSystemMain.has(systemKey)) continue;
      if (systemKey && !dimKeys.has(systemKey)) continue; // цены и пр. пропускаем
      if (!systemKey || dimKeys.has(systemKey)) {
        const onCat = categoryAttrIds.has(String(a.id));
        if (systemKey && dimKeys.has(systemKey)) {
          out.push({
            id: `attr:${a.id}`,
            name: a.name,
            group: 'Общие',
            attrId: String(a.id),
            systemKey,
            type: a.type,
          });
        } else if (onCat) {
          out.push({
            id: `attr:${a.id}`,
            name: a.name,
            group: 'Категория',
            attrId: String(a.id),
            systemKey: systemKey || null,
            type: a.type,
          });
        } else if (!systemKey) {
          out.push({
            id: `attr:${a.id}`,
            name: a.name,
            group: 'Общие',
            attrId: String(a.id),
            systemKey: null,
            type: a.type,
          });
        }
      }
    }
    return out;
  }, [allAttributes, categoryAttrIds]);

  const allTargets = useMemo(
    () => [...MAIN_FIELD_TARGETS, ...extraAttrTargets],
    [extraAttrTargets]
  );

  const extraAttrKey = useMemo(
    () => extraAttrTargets.map((t) => t.id).join(','),
    [extraAttrTargets]
  );

  const { mapping, attributeMappings } = useMemo(
    () => mappingFromFieldMappings(fieldMappings),
    [fieldMappings]
  );

  /** Столбец → кто уже сопоставлен (для подсветки в списках) */
  const columnOwners = useMemo(() => {
    const map = new Map();
    const add = (col, label) => {
      const c = String(col || '');
      const L = String(label || '').trim();
      if (!c || !L) return;
      const prev = map.get(c) || [];
      if (!prev.includes(L)) map.set(c, [...prev, L]);
    };
    const byId = new Map((allTargets || []).map((t) => [String(t.id), t]));
    for (const [tid, cols] of Object.entries(fieldMappings || {})) {
      const t = byId.get(String(tid));
      const label = t?.name || tid;
      for (const col of asColumnList(cols)) add(col, label);
    }
    return map;
  }, [fieldMappings, allTargets]);

  // После выбора категории — подсказать совпадения имён для атрибутов (основное не трогаем)
  useEffect(() => {
    if (!defaults.categoryId) return;
    const suggested = suggestAttributeMappings(
      columns,
      extraAttrTargets.map((t) => ({
        id: t.attrId,
        name: t.name,
        systemKey: t.systemKey,
        type: t.type,
      }))
    );
    if (!Object.keys(suggested).length) return;
    setFieldMappings((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [aid, cols] of Object.entries(suggested)) {
        const tid = `attr:${aid}`;
        if (asColumnList(next[tid]).length) continue;
        next[tid] = cols;
        changed = true;
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaults.categoryId, columns, extraAttrKey]);

  const isRowFinished = (r) =>
    r?.createStatus === 'ok' || r?.createStatus === 'merged';
  const isRowSelectable = (r) => !isRowFinished(r) && !!sessionId;

  const selectedCount = useMemo(
    () => rows.filter((r) => r.selected && isRowSelectable(r)).length,
    [rows, sessionId]
  );
  const selectable = rows.filter((r) => isRowSelectable(r));
  const allSelected =
    selectable.length > 0 && selectable.every((r) => r.selected);

  /** Колонки превью по текущему сопоставлению (чтобы видеть новые значения). */
  const previewValueColumns = useMemo(() => {
    const cols = [];
    const pushMain = (key, label, multiline = false) => {
      const mapped = asColumnList(mapping[key]);
      if (!mapped.length) return;
      cols.push({ id: `main:${key}`, label, mapped, multiline });
    };
    pushMain('description', 'Описание', true);
    pushMain('applicability', 'Применимость', true);
    pushMain('analogs', 'Аналоги', true);
    pushMain('country', 'Страна', false);
    for (const t of extraAttrTargets) {
      const mapped = asColumnList(attributeMappings[t.attrId]);
      if (!mapped.length) continue;
      cols.push({
        id: t.id,
        label: t.name,
        mapped,
        multiline: /textarea|text|html|multiline/i.test(String(t.type || '')),
      });
    }
    return cols;
  }, [mapping, attributeMappings, extraAttrTargets]);

  const applyPreviewData = (data) => {
    const suggested = data?.suggestedMapping || {};
    setSessionId(String(data?.sessionId || ''));
    setColumns(Array.isArray(data?.columns) ? data.columns : []);
    const nextFields = EMPTY_FIELD_MAPPINGS();
    for (const t of MAIN_FIELD_TARGETS) {
      const cols = asColumnList(suggested[t.key]);
      if (cols.length) nextFields[t.id] = cols;
    }
    setFieldMappings(nextFields);
    const nextRows = (data?.rows || []).map((r) => {
      const existingId = r.existingProductId != null ? r.existingProductId : null;
      const exists = !!r.exists || existingId != null;
      return {
        ...r,
        key: rowKey(r),
        selected: true,
        productId: existingId,
        skipped: false,
        exists,
        createStatus: exists ? 'exists' : '',
        createError: exists
          ? `Уже в каталоге (#${existingId})` +
            (r.existingProductName ? `: ${r.existingProductName}` : '')
          : '',
        imagesAdded: null,
        proposals: [],
        filled: [],
      };
    });
    setRows(nextRows);
    setDefaults((d) => ({
      ...d,
      organizationId: d.organizationId || singleOrganizationId || '',
    }));
  };

  const onPickZip = async (e) => {
    const file = e.target.files?.[0] || null;
    // Сначала копируем File: сброс value очищает живой FileList
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    setUploadError('');
    setCreateMessage('');
    setCreateError('');
    setRows([]);
    setSessionId('');
    try {
      const res = await productsApi.catalogBundlePreview(file);
      applyPreviewData(res?.data ?? res);
    } catch (err) {
      setUploadError(
        err?.response?.data?.message || err?.message || 'Не удалось разобрать данные'
      );
    } finally {
      setUploading(false);
    }
  };

  const onPickFolder = async (e) => {
    // FileList живой — Array.from до сброса value, иначе список пустеет
    const list = Array.from(e.target.files || []);
    e.target.value = '';
    if (!list.length) return;
    setUploading(true);
    setUploadProgress('Подготовка…');
    setUploadError('');
    setCreateMessage('');
    setCreateError('');
    setRows([]);
    setSessionId('');
    try {
      const res = await productsApi.catalogBundlePreviewFolder(list, {
        onProgress: ({ phase, done, total }) => {
          if (phase === 'init') setUploadProgress(`Старт загрузки (${total} файлов)…`);
          else if (phase === 'upload') {
            setUploadProgress(`Загрузка ${done} / ${total}…`);
          } else if (phase === 'finalize') {
            setUploadProgress('Разбор Excel и превью…');
          }
        },
      });
      applyPreviewData(res?.data ?? res);
    } catch (err) {
      const msg = err?.response?.data?.message || err?.message || '';
      const isNet =
        !err?.response &&
        (/network error/i.test(msg) || err?.code === 'ERR_NETWORK' || err?.code === 'ECONNABORTED');
      setUploadError(
        isNet
          ? 'Сеть оборвалась при загрузке папки. Повторите или загрузите ZIP.'
          : msg || 'Не удалось загрузить папку'
      );
    } finally {
      setUploading(false);
      setUploadProgress('');
    }
  };

  const updateRow = (key, patch) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const toggleSelectAll = (e) => {
    const checked = e.target.checked;
    setRows((prev) =>
      prev.map((r) => (isRowSelectable(r) ? { ...r, selected: checked } : r))
    );
  };

  const createSelected = async () => {
    if (!sessionId) {
      setCreateError('Сначала загрузите ZIP или папку');
      return;
    }
    const selected = rows.filter((r) => r.selected && isRowSelectable(r));
    if (!selected.length) {
      setCreateError('Выберите позиции');
      return;
    }
    const needsDefaults = selected.some((r) => !r.exists && !r.productId);
    if (needsDefaults && (!defaults.categoryId || !defaults.organizationId)) {
      setCreateError('Укажите категорию и организацию для новых товаров');
      return;
    }
    if (!defaults.categoryId || !defaults.organizationId) {
      // Для дозаполнения тоже нужны — новые атрибуты цепляем к категории
      setCreateError('Укажите категорию и организацию');
      return;
    }
    if (!asColumnList(mapping.sku).length) {
      setCreateError('Укажите колонку артикула');
      return;
    }

    setCreating(true);
    setCreateError('');
    setCreateMessage('');
    try {
      const brandName =
        (brands || []).find((b) => String(b.id) === String(defaults.brandId))?.name ||
        '';
      const res = await productsApi.catalogBundleCreate({
        sessionId,
        mapping,
        attributeMappings,
        defaults: {
          categoryId: defaults.categoryId,
          organizationId: defaults.organizationId,
          brandId: defaults.brandId || undefined,
          brand: brandName || undefined,
          countryOfOrigin: defaults.countryOfOrigin || undefined,
        },
        selectedIndexes: selected.map((r) => r.index),
      });
      const data = res?.data ?? res;
      const byIndex = new Map(
        (data?.results || []).map((r) => [Number(r.index), r])
      );
      setRows((prev) =>
        prev.map((row) => {
          const hit = byIndex.get(Number(row.index));
          if (!hit) return row;
          if (hit.ok && hit.merged) {
            return {
              ...row,
              selected: false,
              productId: hit.productId || row.productId,
              imagesAdded: hit.imagesAdded ?? 0,
              createStatus: 'merged',
              createError: hit.message || hit.imageWarning || '',
              skipped: false,
              exists: true,
              proposals: Array.isArray(hit.proposals) ? hit.proposals : [],
              filled: hit.filled || [],
            };
          }
          if (hit.ok) {
            return {
              ...row,
              selected: false,
              productId: hit.productId,
              imagesAdded: hit.imagesAdded ?? 0,
              createStatus: 'ok',
              createError: '',
              skipped: false,
            };
          }
          if (hit.skipped) {
            return {
              ...row,
              selected: false,
              productId: hit.productId || row.productId,
              skipped: true,
              createStatus: 'skipped',
              createError: hit.error || 'Уже существует',
            };
          }
          return {
            ...row,
            createStatus: 'error',
            createError: hit.error || 'Ошибка создания',
          };
        })
      );
      setCreateMessage(
        `Создано: ${data?.ok ?? 0}` +
          (data?.merged ? `, дополнено: ${data.merged}` : '') +
          (data?.proposalCount ? `, предложений: ${data.proposalCount}` : '') +
          (data?.skipped ? `, пропущено: ${data.skipped}` : '') +
          (data?.failed ? `, ошибок: ${data.failed}` : '')
      );
      const proposalItems = (data?.results || [])
        .filter(
          (x) =>
            x.ok &&
            x.merged &&
            x.productId &&
            Array.isArray(x.proposals) &&
            x.proposals.length > 0
        )
        .map((x) => ({
          productId: x.productId,
          sku: x.sku,
          name: x.name,
          proposals: x.proposals.map((p) => ({ ...p, accept: true })),
        }));
      if (proposalItems.length) {
        setProposalModal({ open: true, items: proposalItems });
      }
      setSessionId('');
    } catch (err) {
      setCreateError(
        err?.response?.data?.message || err?.message || 'Ошибка создания товаров'
      );
    } finally {
      setCreating(false);
    }
  };

  const toggleProposalAccept = (productId, field, accept) => {
    setProposalModal((prev) => ({
      ...prev,
      items: (prev.items || []).map((it) =>
        Number(it.productId) !== Number(productId)
          ? it
          : {
              ...it,
              proposals: (it.proposals || []).map((p) =>
                p.field === field ? { ...p, accept } : p
              ),
            }
      ),
    }));
  };

  const applySelectedProposals = async () => {
    const payload = (proposalModal.items || [])
      .map((it) => ({
        productId: it.productId,
        accepted: (it.proposals || [])
          .filter((p) => p.accept)
          .map((p) => ({
            field: p.field,
            proposed: p.proposed,
            attributeId: p.attributeId,
          })),
      }))
      .filter((it) => it.accepted.length > 0);
    if (!payload.length) {
      setProposalModal({ open: false, items: [] });
      return;
    }
    setApplyingProposals(true);
    try {
      await productsApi.enrichApplyProposals(payload);
      setProposalModal({ open: false, items: [] });
      setCreateMessage((prev) =>
        prev ? `${prev}; предложения применены` : 'Предложения применены'
      );
    } catch (err) {
      setCreateError(
        err?.response?.data?.message || err?.message || 'Не удалось применить предложения'
      );
    } finally {
      setApplyingProposals(false);
    }
  };

  return (
    <div className="catalog-bundle-panel">
      <p className="text-muted small mb-3">
        Загрузите результат парсера: ZIP или целиком папку — один Excel (.xlsx) и рядом папки,
        названные как артикулы, с фото внутри. До 5000 товаров и до 50 фото на товар.
        Уже существующие артикулы можно дозаполнить: пустые поля пишутся сразу, отличия — в
        предложениях.
      </p>

      <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
        <input
          ref={zipRef}
          type="file"
          accept=".zip,application/zip"
          className="d-none"
          onChange={onPickZip}
        />
        <input
          ref={folderRef}
          type="file"
          className="d-none"
          multiple
          onChange={onPickFolder}
        />
        <Button
          type="button"
          variant="primary"
          onClick={() => folderRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? uploadProgress || 'Загрузка…' : 'Выбрать папку'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => zipRef.current?.click()}
          disabled={uploading}
        >
          Загрузить ZIP
        </Button>
        {rows.length > 0 ? (
          <span className="text-muted small">Строк: {rows.length}</span>
        ) : null}
      </div>
      {uploadError ? <div className="error mb-3">{uploadError}</div> : null}

      {rows.length > 0 ? (
        <>
          <section className="catalog-bundle-defaults mb-3">
            <h2 className="h6 mb-2">Общие поля для создания</h2>
            <div className="catalog-bundle-mapping-grid">
              <label className="small">
                Категория
                <select
                  className="form-control form-control-sm"
                  value={defaults.categoryId}
                  onChange={(e) =>
                    setDefaults((d) => ({ ...d, categoryId: e.target.value }))
                  }
                >
                  <option value="">—</option>
                  {(categories || []).map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="small">
                Организация
                <select
                  className="form-control form-control-sm"
                  value={defaults.organizationId}
                  onChange={(e) =>
                    setDefaults((d) => ({ ...d, organizationId: e.target.value }))
                  }
                >
                  <option value="">—</option>
                  {(organizations || []).map((o) => (
                    <option key={o.id} value={String(o.id)}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="small">
                Бренд (справочник)
                <select
                  className="form-control form-control-sm"
                  value={defaults.brandId}
                  onChange={(e) => setDefaults((d) => ({ ...d, brandId: e.target.value }))}
                >
                  <option value="">— из колонки / пусто</option>
                  {(brands || []).map((b) => (
                    <option key={b.id} value={String(b.id)}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="small">
                Страна производителя
                <input
                  type="text"
                  className="form-control form-control-sm"
                  value={defaults.countryOfOrigin}
                  onChange={(e) =>
                    setDefaults((d) => ({ ...d, countryOfOrigin: e.target.value }))
                  }
                  placeholder="Например: Китай"
                  autoComplete="off"
                />
                <span className="text-muted" style={{ fontSize: 11 }}>
                  Для всех товаров. Если есть колонка «Страна», она важнее.
                </span>
              </label>
            </div>
          </section>

          <section className="catalog-bundle-mapping mb-3">
            <h2 className="h6 mb-2">Сопоставление атрибутов</h2>
                <p className="text-muted small mb-2">
                  Столбцы выбираются напротив названия. Ниже можно добавить ещё связь.
                  Несколько столбцов: в многострочных полях — с переносом, в однострочных — через
                  «. ». Габариты упаковки/товара подставляются только вручную. Уже занятые
                  столбцы подсвечены.
                </p>
            <AttributeMappingPicker
              targets={allTargets}
              columns={columns}
              value={fieldMappings}
              columnOwners={columnOwners}
              onChange={setFieldMappings}
            />
          </section>

          <div className="product-enrichment-bulk-bar">
            <Button
              type="button"
              variant="primary"
              size="small"
              onClick={createSelected}
              disabled={creating || selectedCount === 0 || !sessionId}
            >
              {creating
                ? 'Создание…'
                : `Добавить / дополнить (${selectedCount})`}
            </Button>
            {!sessionId ? (
              <span className="text-muted small ms-2">
                Сессия уже использована — загрузите данные снова для нового импорта
              </span>
            ) : null}
          </div>
          {createMessage ? <div className="small mb-2">{createMessage}</div> : null}
          {createError ? <div className="error mb-2">{createError}</div> : null}

          <div className="product-enrichment-table-wrap">
            <table className="product-enrichment-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      title="Выбрать все"
                      aria-label="Выбрать все"
                    />
                  </th>
                  <th>Артикул</th>
                  <th>Название</th>
                  <th>Бренд</th>
                  <th>Фото</th>
                  {previewValueColumns.map((c) => (
                    <th key={c.id}>{c.label}</th>
                  ))}
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.key}
                    className={
                      row.createStatus === 'merged'
                        ? 'is-merged'
                        : row.createStatus === 'ok'
                          ? 'is-created'
                          : row.createStatus === 'skipped'
                            ? 'is-skipped'
                            : row.createStatus === 'error'
                              ? 'is-error'
                              : row.exists
                                ? 'is-exists'
                                : ''
                    }
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={!!row.selected}
                        disabled={!isRowSelectable(row)}
                        onChange={(e) => updateRow(row.key, { selected: e.target.checked })}
                        aria-label={`Выбрать ${row.sku}`}
                      />
                    </td>
                    <td>
                      <div className="small fw-semibold">{row.sku || '—'}</div>
                      {row.createStatus === 'merged' && row.productId ? (
                        <div className="text-success small">
                          <a href={`/products/${row.productId}`}>дополнено #{row.productId}</a>
                        </div>
                      ) : row.exists && row.productId ? (
                        <div className="text-muted small">
                          <a href={`/products/${row.productId}`}>уже есть #{row.productId}</a>
                          {!isRowFinished(row) ? (
                            <div>можно выбрать и дополнить</div>
                          ) : null}
                        </div>
                      ) : row.createStatus === 'ok' && row.productId ? (
                        <div className="text-success small">#{row.productId}</div>
                      ) : null}
                    </td>
                    <td>
                      <div className="product-enrichment-name-cell">{row.name || '—'}</div>
                    </td>
                    <td className="small">{row.brand || '—'}</td>
                    <td className="small">
                      {row.imagesAdded != null
                        ? `${row.imagesAdded} прикреплено`
                        : row.imageCount
                          ? `${row.imageCount} в папке`
                          : '—'}
                    </td>
                    {previewValueColumns.map((c) => {
                      const text = resolveRawMapped(row.raw, c.mapped, {
                        multiline: c.multiline,
                      });
                      return (
                        <td key={c.id} className="small product-enrichment-cell-scroll">
                          {text ? (
                            <pre className="product-enrichment-desc product-enrichment-desc--cell">
                              {text}
                            </pre>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="small">
                      {row.createStatus === 'merged' ? (
                        <div className="text-success">
                          {row.createError || 'дополнено'}
                          {Array.isArray(row.proposals) && row.proposals.length ? (
                            <div className="text-muted">
                              предложений: {row.proposals.length}
                            </div>
                          ) : null}
                        </div>
                      ) : row.createStatus === 'error' ? (
                        <div className="text-danger">{row.createError || 'ошибка'}</div>
                      ) : row.createStatus === 'ok' ? (
                        <span className="text-success">создан</span>
                      ) : row.exists ? (
                        <div className="text-muted">
                          {row.createError || 'уже есть в каталоге'}
                        </div>
                      ) : row.warnings?.length ? (
                        <span className="text-warning">{row.warnings.join('; ')}</span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <Modal
        isOpen={proposalModal.open}
        onClose={() => {
          if (!applyingProposals) setProposalModal({ open: false, items: [] });
        }}
        title="Предложения по уже заполненным полям"
        size="large"
      >
        <div>
          <p className="text-muted small mb-3">
            Пустые поля уже дополнены. Ниже — отличия от текущих значений в каталоге. Отметьте, что
            заменить.
          </p>
          <div className="product-enrichment-proposals">
            {(proposalModal.items || []).map((it) => (
              <div key={String(it.productId)} className="product-enrichment-proposal-card">
                <div className="fw-semibold mb-2">
                  {it.sku || '—'}
                  {it.name ? ` · ${it.name}` : ''}
                  <span className="text-muted small ms-2">#{it.productId}</span>
                </div>
                <table className="table table-sm mb-0">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }} />
                      <th>Поле</th>
                      <th>Сейчас</th>
                      <th>Из файла</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(it.proposals || []).map((p) => (
                      <tr key={`${it.productId}-${p.field}`}>
                        <td>
                          <input
                            type="checkbox"
                            checked={!!p.accept}
                            disabled={applyingProposals}
                            onChange={(e) =>
                              toggleProposalAccept(it.productId, p.field, e.target.checked)
                            }
                            aria-label={`Принять ${p.label || p.field}`}
                          />
                        </td>
                        <td>{p.label || p.field}</td>
                        <td>
                          <div className="product-enrichment-proposal-val">{p.current || '—'}</div>
                        </td>
                        <td>
                          <div className="product-enrichment-proposal-val">{p.proposed || '—'}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
          <div className="d-flex justify-content-end gap-2 mt-3">
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={applyingProposals}
              onClick={() => setProposalModal({ open: false, items: [] })}
            >
              Пропустить
            </Button>
            <Button
              type="button"
              variant="primary"
              size="small"
              disabled={applyingProposals}
              onClick={applySelectedProposals}
            >
              {applyingProposals ? 'Применение…' : 'Применить выбранные'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default CatalogBundleImportPanel;
