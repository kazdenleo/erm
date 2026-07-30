/**
 * Налоги и чистый доход для строк аналитики маркетплейсов (FBS/FBO).
 */

import { query } from '../config/database.js';
import {
  computeTaxesAndNetProfit,
  formatTaxSystemLabel,
  resolveOrganizationTaxProfile,
} from './organizationTaxRates.js';

function formatRubTooltip(n) {
  const v = Number(n) || 0;
  return `${Math.round(v).toLocaleString('ru-RU')} ₽`;
}

function buildTaxTooltip({
  vat,
  incomeTax,
  taxProfile,
  orgName,
  taxSystemRaw,
  price,
  totalExpenses,
  profitBeforeIncomeTax,
}) {
  const parts = [];
  if (orgName) parts.push(`Организация: ${orgName}`);
  const label = formatTaxSystemLabel(taxSystemRaw || taxProfile?.taxSystemCode);
  if (label && label !== '—') parts.push(`Схема: ${label}`);
  if ((taxProfile?.vatRate || 0) > 0) {
    parts.push(`НДС ${(taxProfile.vatRate * 100).toFixed(0)}%: ${formatRubTooltip(vat)}`);
  }
  if ((taxProfile?.incomeTaxRate || 0) > 0) {
    if (taxProfile.incomeTaxOnRevenue) {
      parts.push(`Налог ${(taxProfile.incomeTaxRate * 100).toFixed(0)}% с выручки: ${formatRubTooltip(incomeTax)}`);
    } else {
      parts.push(
        `Налог ${(taxProfile.incomeTaxRate * 100).toFixed(0)}% с прибыли: ${formatRubTooltip(incomeTax)}`
      );
      parts.push(
        `База: выручка ${formatRubTooltip(price)} − расходы ${formatRubTooltip(totalExpenses)}` +
          ((taxProfile.vatRate || 0) > 0 ? ` − НДС ${formatRubTooltip(vat)}` : '') +
          ` = ${formatRubTooltip(profitBeforeIncomeTax)}`
      );
      if ((Number(profitBeforeIncomeTax) || 0) <= 0 && (Number(incomeTax) || 0) === 0) {
        parts.push('Налог 0 ₽: нет положительной прибыли (УСН «доходы − расходы» / ОСН).');
      }
    }
  }
  if (!parts.length) {
    return 'Не указана система налогообложения организации';
  }
  parts.push(`Итого налоги: ${formatRubTooltip(vat + incomeTax)}`);
  return parts.join('\n');
}

export function computeMarketplaceRowTax({
  retailAmount,
  costAmount = 0,
  expensesTotal = 0,
  taxProfile,
  orgName = null,
  taxSystemRaw = null,
}) {
  const price = Number(retailAmount) || 0;
  const totalExpenses = (Number(costAmount) || 0) + (Number(expensesTotal) || 0);
  const profile = taxProfile || resolveOrganizationTaxProfile(null);
  const { vat, incomeTax, netProfit, profitBeforeIncomeTax } = computeTaxesAndNetProfit({
    price,
    totalExpenses,
    taxProfile: profile,
  });
  const taxAmount = vat + incomeTax;
  const taxConfigured =
    Boolean(taxSystemRaw || profile.taxSystemCode) ||
    profile.vatRate > 0 ||
    profile.incomeTaxRate > 0;

  return {
    taxAmount,
    vatAmount: vat,
    incomeTaxAmount: incomeTax,
    netIncome: netProfit,
    profitBeforeIncomeTax,
    taxTooltip: buildTaxTooltip({
      vat,
      incomeTax,
      taxProfile: profile,
      orgName,
      taxSystemRaw,
      price,
      totalExpenses,
      profitBeforeIncomeTax,
    }),
    organizationName: orgName || null,
    taxConfigured,
  };
}

/**
 * Загружает организации профиля и привязку товар → организация.
 */
export async function loadMarketplaceTaxContext(profileId) {
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) {
    return {
      orgById: new Map(),
      productOrgId: new Map(),
      defaultOrg: null,
    };
  }

  const [orgsRes, productsRes] = await Promise.all([
    query(
      `SELECT id, name, tax_system, vat
       FROM organizations
       WHERE profile_id = $1
       ORDER BY id ASC`,
      [pid]
    ),
    query(
      `SELECT p.id, p.organization_id
       FROM products p
       INNER JOIN organizations o ON o.id = p.organization_id AND o.profile_id = $1`,
      [pid]
    ),
  ]);

  const orgById = new Map();
  for (const row of orgsRes.rows || []) {
    orgById.set(Number(row.id), row);
  }

  const productOrgId = new Map();
  for (const row of productsRes.rows || []) {
    productOrgId.set(Number(row.id), Number(row.organization_id) || null);
  }

  const orgs = [...orgById.values()];
  const defaultOrg =
    orgs.find((o) => o.tax_system) ||
    orgs[0] ||
    null;

  return { orgById, productOrgId, defaultOrg };
}

function resolveOrgForProduct(productId, taxContext) {
  const { orgById, productOrgId, defaultOrg } = taxContext;
  const pid = productId != null ? Number(productId) : null;
  if (Number.isFinite(pid) && pid > 0) {
    const orgId = productOrgId.get(pid);
    if (orgId && orgById.has(orgId)) return orgById.get(orgId);
  }
  return defaultOrg;
}

export function enrichAnalyticsRowWithTax(row, taxContext) {
  const org = resolveOrgForProduct(row.productId, taxContext);
  const taxProfile = resolveOrganizationTaxProfile(org);
  const retailAmount = row.retailAmount ?? row.soldAmount ?? 0;
  const expensesTotal = row.expensesTotal ?? 0;
  const taxFields = computeMarketplaceRowTax({
    retailAmount,
    costAmount: row.costAmount ?? 0,
    expensesTotal,
    taxProfile,
    orgName: org?.name || null,
    taxSystemRaw: org?.tax_system || null,
  });
  return { ...row, ...taxFields };
}

export async function enrichAnalyticsItemsWithTax(items, profileId) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return list;
  const taxContext = await loadMarketplaceTaxContext(profileId);
  return list.map((row) => enrichAnalyticsRowWithTax(row, taxContext));
}

export function buildTaxMetaFromContext(taxContext) {
  const org = taxContext?.defaultOrg;
  if (!org) {
    return {
      organizationName: null,
      taxSystemLabel: null,
      vatLabel: null,
      vatRate: 0,
      configured: false,
    };
  }
  const profile = resolveOrganizationTaxProfile(org);
  const vatPct = profile.vatRate > 0 ? Math.round(profile.vatRate * 100) : 0;
  const vatLabel = vatPct > 0 ? `НДС ${vatPct}%` : 'Без НДС';
  const taxSystemLabel = formatTaxSystemLabel(org.tax_system);
  const parts = [];
  if (taxSystemLabel && taxSystemLabel !== '—') parts.push(taxSystemLabel);
  if (vatPct > 0) parts.push(vatLabel);
  return {
    organizationName: org.name || null,
    taxSystemLabel: parts.length ? parts.join(' + ') : taxSystemLabel,
    vatLabel,
    vatRate: profile.vatRate,
    configured: Boolean(org.tax_system || profile.vatRate > 0),
  };
}
