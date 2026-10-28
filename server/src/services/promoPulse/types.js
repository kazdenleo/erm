/** @typedef {'ozon' | 'wb' | 'ym'} MarketplaceId */

/** @typedef {'elastic' | 'percent_off' | 'stock' | 'other'} PromoActionKind */

/** @typedef {'A' | 'B' | 'C'} PulsePhase */

/** @typedef {'hero' | 'normal' | 'stock' | 'new'} PulseSegment */

/**
 * @typedef {Object} PromoAction
 * @property {MarketplaceId} marketplace
 * @property {string} external_id
 * @property {string} [title]
 * @property {PromoActionKind} kind
 * @property {string|null} [starts_at]
 * @property {string|null} [ends_at]
 * @property {object} [meta]
 */

/**
 * @typedef {Object} PromoLevel
 * @property {number} boost
 * @property {number} price
 * @property {number|null} [profit_rub]
 * @property {boolean} [below_floor]
 * @property {string|null} [join_block_reason]
 * @property {boolean} [current]
 */

/**
 * @typedef {Object} PromoOffer
 * @property {MarketplaceId} marketplace
 * @property {string} action_id
 * @property {string|number} external_product_id
 * @property {number|null} [our_product_id]
 * @property {number|null} [list_price]
 * @property {number|null} [promo_price]
 * @property {number|null} [entry_price]
 * @property {number|null} [floor]
 * @property {number|null} [selling_price]
 * @property {number|null} [markup_rub]
 * @property {number|null} [profit_rub]
 * @property {PromoLevel[]} [levels]
 * @property {boolean} participating
 * @property {boolean} can_join
 * @property {boolean} can_leave
 * @property {boolean} [can_set_level]
 * @property {object} [meta]
 */

/**
 * @typedef {Object} PulseCommand
 * @property {'join'|'leave'|'set_level'|'skip'} type
 * @property {MarketplaceId} marketplace
 * @property {string} action_id
 * @property {string|number} external_product_id
 * @property {number|null} [our_product_id]
 * @property {number|null} [price]
 * @property {number|null} [level]
 * @property {string} reason
 * @property {PulsePhase} [phase]
 */

/**
 * @typedef {Object} PortCapabilities
 * @property {boolean} join
 * @property {boolean} leave
 * @property {boolean} setLevel
 * @property {boolean} levels
 * @property {boolean} percentOffJoin
 */

/**
 * @typedef {Object} PromoMarketplacePort
 * @property {MarketplaceId} id
 * @property {() => PortCapabilities} capabilities
 * @property {(scope: object) => Promise<PromoAction[]>} listActions
 * @property {(scope: object, actionId: string|number) => Promise<PromoOffer[]>} listParticipating
 * @property {(scope: object, actionId: string|number) => Promise<PromoOffer[]>} listCandidates
 * @property {(scope: object, commands: PulseCommand[], opts?: { dryRun?: boolean }) => Promise<{ ok: boolean, results: object[] }>} apply
 */

export const MARKETPLACES = ['ozon', 'wb', 'ym'];
export const ACTION_KINDS = ['elastic', 'percent_off', 'stock', 'other'];
export const SEGMENTS = ['hero', 'normal', 'stock', 'new'];
export const PHASES = ['A', 'B', 'C'];

export function defaultPolicyConfig() {
  return {
    marketplaces: ['ozon'],
    action_kinds: ['elastic', 'percent_off', 'stock', 'other'],
    phase_a_days: 14,
    phase_b_days: 7,
    phase_c_days: 1,
    max_b_share_30d: 0.333,
    require_profit_ge_markup: true,
    allow_below_floor_stock: false,
    new_product_base_days: 14,
    dry_run: true,
  };
}

/** Дней фазы C из политики / config (по умолчанию 1). */
export function phaseCDaysOf(policy) {
  const fromConfig = Number(policy?.config?.phase_c_days);
  if (Number.isFinite(fromConfig) && fromConfig >= 1) return Math.min(30, fromConfig);
  const top = Number(policy?.phase_c_days);
  if (Number.isFinite(top) && top >= 1) return Math.min(30, top);
  return 1;
}
