/**
 * Лимиты веса грузомест FBO из настроек маркетплейса.
 */

import integrationsService from '../services/integrations.service.js';

function parseLimitKg(v) {
  const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizeMarketplaceForIntegrations(mp) {
  const m = String(mp || '').trim().toLowerCase();
  if (m === 'wb' || m === 'wildberries') return 'wildberries';
  if (m === 'ym' || m === 'yandex') return 'yandex';
  return 'ozon';
}

export function parseFboWeightLimitsFromConfig(config) {
  const raw = config && typeof config === 'object' ? config : {};
  return {
    maxBoxWeightKg: parseLimitKg(raw.fbo_max_box_weight_kg ?? raw.fboMaxBoxWeightKg),
    maxPalletWeightKg: parseLimitKg(raw.fbo_max_pallet_weight_kg ?? raw.fboMaxPalletWeightKg),
  };
}

export async function loadFboWeightLimitsForSupply(supply, { profileId } = {}) {
  const orgId = supply?.organizationId ?? supply?.organization_id ?? null;
  const mpType = normalizeMarketplaceForIntegrations(supply?.marketplace);
  if (orgId == null || orgId === '') {
    return { maxBoxWeightKg: null, maxPalletWeightKg: null };
  }
  try {
    const config = await integrationsService.getMarketplaceConfig(mpType, {
      profileId,
      organizationId: orgId,
    });
    return parseFboWeightLimitsFromConfig(config);
  } catch {
    return { maxBoxWeightKg: null, maxPalletWeightKg: null };
  }
}

export function cargoKindLabel(kind) {
  return kind === 'pallet' ? 'паллета' : 'короб';
}

export function weightLimitKgForCargo(cargo, limits) {
  const kind = cargo?.cargoKind === 'pallet' ? 'pallet' : 'box';
  return kind === 'pallet' ? limits?.maxPalletWeightKg ?? null : limits?.maxBoxWeightKg ?? null;
}

export function enrichCargoWeightLimits(cargo, limits) {
  const limitKg = weightLimitKgForCargo(cargo, limits);
  const totalKg = (Number(cargo.totalWeightG) || 0) / 1000;
  const weightExceeded = limitKg != null && totalKg > limitKg;
  return {
    ...cargo,
    weightLimitKg: limitKg,
    weightExceeded,
    weightExceededByKg: weightExceeded ? totalKg - limitKg : null,
  };
}

export function buildWeightExceededMessage(cargo) {
  if (!cargo?.weightExceeded) return null;
  const kind = cargoKindLabel(cargo.cargoKind);
  const limit = cargo.weightLimitKg;
  const totalKg = ((Number(cargo.totalWeightG) || 0) / 1000).toFixed(2);
  return `Превышен вес грузоместа (${kind}): ${totalKg} кг при лимите ${limit} кг`;
}
