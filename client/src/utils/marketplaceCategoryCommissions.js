/**
 * Комиссии маркетплейсов по схемам продаж для сопоставленных категорий.
 */

import {
  getMpCommissionKeysForWorkingSchemes,
  describeWorkingSchemes as describeWorkingSchemesFromFlags,
} from '../constants/marketplaceSalesSchemes.js';

/** Схемы WB — те же поля, что в Integrations → Wildberries → Комиссия */
export const WB_COMMISSION_SCHEMES = [
  { key: 'kgvpBooking', label: 'Бронирование', shortLabel: 'Бронь' },
  { key: 'kgvpMarketplace', label: 'Маркетплейс (FBS)', shortLabel: 'FBS' },
  { key: 'kgvpPickup', label: 'Самовывоз (C&C)', shortLabel: 'C&C' },
  { key: 'kgvpSupplier', label: 'Витрина/курьер (DBS/DBW)', shortLabel: 'DBS' },
  { key: 'kgvpSupplierExpress', label: 'Витрина экспресс (EDBS)', shortLabel: 'EDBS' },
  { key: 'paidStorageKgvp', label: 'Склад WB (FBO/FBW)', shortLabel: 'FBO' },
];

export function formatCommissionPercent(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `${n}%`;
}

/**
 * @param {Array<{ subjectID?: number|string, [key: string]: unknown }>|null|undefined} report
 * @returns {Map<string, object>}
 */
export function buildWbCommissionsMap(report) {
  const map = new Map();
  if (!Array.isArray(report)) return map;
  for (const row of report) {
    const id = row?.subjectID ?? row?.category_id ?? row?.categoryId;
    if (id == null || id === '') continue;
    map.set(String(id), row);
  }
  return map;
}

/**
 * @param {object|null|undefined} reportItem
 * @returns {Array<{ key: string, label: string, shortLabel: string, value: number|null, display: string|null }>}
 */
export function getWbCommissionSchemeValues(reportItem) {
  if (!reportItem || typeof reportItem !== 'object') return [];
  return WB_COMMISSION_SCHEMES.map((scheme) => {
    const raw = reportItem[scheme.key];
    const display = formatCommissionPercent(raw);
    const value = display != null ? Number(raw) : null;
    return { ...scheme, value, display };
  });
}

export function hasAnyWbCommission(reportItem) {
  return getWbCommissionSchemeValues(reportItem).some((s) => s.display != null);
}

export function getWbCommissionSchemesForDisplay(reportItem) {
  const schemes = getWbCommissionSchemeValues(reportItem).filter((s) => s.display);
  return {
    schemes,
    note: schemes.length
      ? null
      : 'Комиссии WB не найдены — обновите отчёт в Интеграциях → Wildberries → Комиссия',
  };
}

/**
 * Схемы комиссии, по которым работает аккаунт (Настройки → схемы продаж).
 * @param {string} marketplace
 * @param {{ fbs?: boolean, fbo?: boolean, dbs?: boolean, edbs?: boolean, cnc?: boolean, rfbs?: boolean, booking?: boolean }} flags
 * @returns {string[]}
 */
export function getMpWorkingSchemeKeys(marketplace, flags = {}) {
  return getMpCommissionKeysForWorkingSchemes(marketplace, {
    fbs: flags.fbs !== false,
    fbo: flags.fbo === true,
    dbs: flags.dbs === true,
    edbs: flags.edbs === true,
    cnc: flags.cnc === true,
    rfbs: flags.rfbs === true,
    booking: flags.booking === true,
  });
}

export function describeWorkingSchemes(flags = {}) {
  return describeWorkingSchemesFromFlags({
    fbs: flags.fbs !== false,
    fbo: flags.fbo === true,
    dbs: flags.dbs === true,
    edbs: flags.edbs === true,
    cnc: flags.cnc === true,
    rfbs: flags.rfbs === true,
    booking: flags.booking === true,
  });
}

/** Убирает из пояснения устаревшую фразу о схеме для мин. цен (приходит из кэша комиссий). */
export function stripPriceCalcSchemeNote(note) {
  if (!note) return note;
  const out = String(note).replace(/\s*В расчёте мин\. цен[\s\S]*$/, '').trim();
  return out || null;
}

/** Собрать уникальные id категорий Ozon/YM из обогащённого списка MySell-категорий */
export function collectCommissionPreviewIds(categories) {
  /** @type {Map<string, number|string|null>} */
  const ozon = new Map();
  const ym = new Set();
  for (const cat of categories || []) {
    const mp = cat?.mappings;
    if (!mp || typeof mp !== 'object') continue;
    for (const [marketplace, rows] of Object.entries(mp)) {
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) continue;
      const cid = row.marketplace_category_id ?? row.category_id;
      if (cid == null || cid === '') continue;
      const s = String(cid);
      if (marketplace === 'ozon' && !ozon.has(s)) {
        ozon.set(s, cat.id ?? null);
      }
      if (marketplace === 'ym' || marketplace === 'yandex') ym.add(s);
    }
  }
  return {
    ozon: [...ozon.entries()].map(([id, userCategoryId]) => ({ id, userCategoryId })),
    ym: [...ym],
  };
}

function normalizeOzonPreviewKey(id) {
  if (id == null || id === '') return '';
  return String(id).trim().replace(/^ozon_/i, '');
}

function normalizeMpCommissionEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const schemes = (entry.schemes || []).map((s) => ({
    ...s,
    display: s.display ?? formatCommissionPercent(s.percent),
  }));
  return { ...entry, schemes };
}

export function resolveMpCommissionEntry(preview, marketplace, categoryId) {
  if (!preview || categoryId == null || categoryId === '') return null;
  const mp = String(marketplace || '').toLowerCase();
  const id = String(categoryId);
  if (mp === 'ozon') {
    const bucket = preview.ozon || {};
    const direct = bucket[id] ?? bucket[normalizeOzonPreviewKey(id)];
    if (direct) return normalizeMpCommissionEntry(direct);
    const clean = normalizeOzonPreviewKey(id);
    for (const [key, value] of Object.entries(bucket)) {
      if (normalizeOzonPreviewKey(key) === clean) {
        return normalizeMpCommissionEntry(value);
      }
    }
    return null;
  }
  if (mp === 'ym' || mp === 'yandex') {
    return normalizeMpCommissionEntry(preview.ym?.[id] ?? null);
  }
  return null;
}
