import { query } from '../../config/database.js';
import { defaultPolicyConfig, MARKETPLACES, SEGMENTS, phaseCDaysOf } from './types.js';
import { advancePhase, appendPhaseLog, daysInBOver30d, evaluateOffer } from './engine.js';
import { getPromoPort, listPromoPorts } from './registry.js';

function profileIdOf(options = {}) {
  const scope = options.integrationScope || options;
  const n = Number(scope.profileId ?? scope.profile_id ?? options.profileId);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function rowToPolicy(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    profile_id: Number(row.profile_id),
    name: row.name,
    description: row.description || '',
    is_active: row.is_active !== false,
    is_default: row.is_default === true,
    marketplaces: Array.isArray(row.marketplaces) ? row.marketplaces : ['ozon'],
    action_kinds: Array.isArray(row.action_kinds) ? row.action_kinds : defaultPolicyConfig().action_kinds,
    phase_a_days: Number(row.phase_a_days) || 14,
    phase_b_days: Number(row.phase_b_days) || 7,
    max_b_share_30d: Number(row.max_b_share_30d) || 0.333,
    require_profit_ge_markup: row.require_profit_ge_markup !== false,
    allow_below_floor_stock: row.allow_below_floor_stock === true,
    new_product_base_days: Number(row.new_product_base_days) || 14,
    dry_run: row.dry_run !== false,
    config: row.config && typeof row.config === 'object' ? row.config : {},
  };
}

export async function listPolicies(options = {}) {
  const profileId = profileIdOf(options);
  if (!profileId) return [];
  const r = await query(
    `SELECT * FROM promo_pulse_policies WHERE profile_id = $1 ORDER BY is_default DESC, id ASC`,
    [profileId]
  );
  return (r.rows || []).map(rowToPolicy);
}

export async function ensureDefaultPolicy(options = {}) {
  const profileId = profileIdOf(options);
  if (!profileId) return null;
  const existing = await listPolicies(options);
  if (existing.length) return existing.find((p) => p.is_default) || existing[0];
  const d = defaultPolicyConfig();
  const r = await query(
    `INSERT INTO promo_pulse_policies (
      profile_id, name, description, is_active, is_default, marketplaces, action_kinds,
      phase_a_days, phase_b_days, max_b_share_30d, require_profit_ge_markup,
      allow_below_floor_stock, new_product_base_days, dry_run
    ) VALUES ($1,$2,$3,true,true,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)
    RETURNING *`,
    [
      profileId,
      'Пульс акций',
      'Фазы A/B/C: набор медианы → удар бустингом → выход. По умолчанию только preview (dry-run).',
      JSON.stringify(d.marketplaces),
      JSON.stringify(d.action_kinds),
      d.phase_a_days,
      d.phase_b_days,
      d.max_b_share_30d,
      d.require_profit_ge_markup,
      d.allow_below_floor_stock,
      d.new_product_base_days,
      true,
    ]
  );
  return rowToPolicy(r.rows[0]);
}

export async function getPolicy(id, options = {}) {
  const profileId = profileIdOf(options);
  const r = await query(`SELECT * FROM promo_pulse_policies WHERE id = $1 LIMIT 1`, [Number(id)]);
  const row = r.rows?.[0];
  if (!row) return null;
  if (profileId && Number(row.profile_id) !== profileId) return null;
  return rowToPolicy(row);
}

export async function createPolicy(body = {}, options = {}) {
  const profileId = profileIdOf(options);
  if (!profileId) throw new Error('Нет профиля');
  const d = defaultPolicyConfig();
  const marketplaces = Array.isArray(body.marketplaces)
    ? body.marketplaces.filter((m) => MARKETPLACES.includes(m))
    : d.marketplaces;
  const isDefault = body.is_default === true;
  if (isDefault) {
    await query(`UPDATE promo_pulse_policies SET is_default = false WHERE profile_id = $1`, [profileId]);
  }
  const r = await query(
    `INSERT INTO promo_pulse_policies (
      profile_id, name, description, is_active, is_default, marketplaces, action_kinds,
      phase_a_days, phase_b_days, max_b_share_30d, require_profit_ge_markup,
      allow_below_floor_stock, new_product_base_days, dry_run, config
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
    RETURNING *`,
    [
      profileId,
      String(body.name || 'Пульс акций').slice(0, 200),
      body.description != null ? String(body.description) : '',
      body.is_active !== false,
      isDefault,
      JSON.stringify(marketplaces.length ? marketplaces : ['ozon']),
      JSON.stringify(Array.isArray(body.action_kinds) ? body.action_kinds : d.action_kinds),
      Number(body.phase_a_days) || d.phase_a_days,
      Number(body.phase_b_days) || d.phase_b_days,
      body.max_b_share_30d != null ? Number(body.max_b_share_30d) : d.max_b_share_30d,
      body.require_profit_ge_markup !== false,
      body.allow_below_floor_stock === true,
      body.new_product_base_days != null ? Number(body.new_product_base_days) : d.new_product_base_days,
      body.dry_run !== false,
      JSON.stringify(body.config && typeof body.config === 'object' ? body.config : {}),
    ]
  );
  return rowToPolicy(r.rows[0]);
}

export async function updatePolicy(id, body = {}, options = {}) {
  const current = await getPolicy(id, options);
  if (!current) return null;
  const profileId = current.profile_id;
  if (body.is_default === true) {
    await query(`UPDATE promo_pulse_policies SET is_default = false WHERE profile_id = $1 AND id <> $2`, [
      profileId,
      current.id,
    ]);
  }
  const marketplaces = Array.isArray(body.marketplaces)
    ? body.marketplaces.filter((m) => MARKETPLACES.includes(m))
    : current.marketplaces;
  const r = await query(
    `UPDATE promo_pulse_policies SET
      name = $2,
      description = $3,
      is_active = $4,
      is_default = $5,
      marketplaces = $6::jsonb,
      action_kinds = $7::jsonb,
      phase_a_days = $8,
      phase_b_days = $9,
      max_b_share_30d = $10,
      require_profit_ge_markup = $11,
      allow_below_floor_stock = $12,
      new_product_base_days = $13,
      dry_run = $14,
      config = $15::jsonb,
      updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING *`,
    [
      current.id,
      body.name != null ? String(body.name).slice(0, 200) : current.name,
      body.description != null ? String(body.description) : current.description,
      body.is_active != null ? body.is_active !== false : current.is_active,
      body.is_default != null ? body.is_default === true : current.is_default,
      JSON.stringify(marketplaces.length ? marketplaces : ['ozon']),
      JSON.stringify(Array.isArray(body.action_kinds) ? body.action_kinds : current.action_kinds),
      body.phase_a_days != null ? Number(body.phase_a_days) : current.phase_a_days,
      body.phase_b_days != null ? Number(body.phase_b_days) : current.phase_b_days,
      body.max_b_share_30d != null ? Number(body.max_b_share_30d) : current.max_b_share_30d,
      body.require_profit_ge_markup != null
        ? body.require_profit_ge_markup !== false
        : current.require_profit_ge_markup,
      body.allow_below_floor_stock != null
        ? body.allow_below_floor_stock === true
        : current.allow_below_floor_stock,
      body.new_product_base_days != null
        ? Number(body.new_product_base_days)
        : current.new_product_base_days,
      body.dry_run != null ? body.dry_run !== false : current.dry_run,
      JSON.stringify(body.config && typeof body.config === 'object' ? body.config : current.config),
    ]
  );
  return rowToPolicy(r.rows[0]);
}

async function loadStateMap(profileId, marketplace) {
  const r = await query(
    `SELECT * FROM promo_pulse_state
     WHERE profile_id = $1 AND marketplace = $2`,
    [profileId, marketplace]
  );
  const map = new Map();
  for (const row of r.rows || []) {
    const key = `${row.action_external_id}:${row.our_product_id || ''}:${row.external_product_id || ''}`;
    map.set(key, row);
  }
  return map;
}

function stateKey(actionId, offer) {
  return `${actionId}:${offer.our_product_id || ''}:${offer.external_product_id || ''}`;
}

async function upsertPulseState(profileId, {
  marketplace,
  action_external_id,
  our_product_id,
  external_product_id,
  phase,
  phase_started_at,
  target_price,
  target_level,
  last_decision,
}) {
  const ourId = our_product_id != null ? Number(our_product_id) : null;
  const extId = external_product_id != null ? String(external_product_id) : null;
  const existing = await query(
    `SELECT id, phase, phase_started_at, last_decision FROM promo_pulse_state
     WHERE profile_id = $1
       AND marketplace = $2
       AND action_external_id = $3
       AND COALESCE(our_product_id, 0) = COALESCE($4::bigint, 0)
       AND COALESCE(external_product_id, '') = COALESCE($5::text, '')
     LIMIT 1`,
    [profileId, marketplace, String(action_external_id), ourId, extId]
  );
  const row = existing.rows?.[0];
  const startedAt =
    row && row.phase === phase && row.phase_started_at
      ? row.phase_started_at
      : phase_started_at;

  const prevLog = row?.last_decision?.phase_log;
  const phaseLog = appendPhaseLog(prevLog, {
    fromPhase: row?.phase,
    fromStartedAt: row?.phase_started_at,
    toPhase: phase,
  });
  const decisionPayload = {
    ...(last_decision || {}),
    phase_log: phaseLog,
  };

  if (row) {
    await query(
      `UPDATE promo_pulse_state SET
        phase = $2,
        phase_started_at = $3::timestamptz,
        target_price = $4,
        target_level = $5,
        last_decision = $6::jsonb,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [
        row.id,
        phase,
        startedAt,
        target_price != null ? Number(target_price) : null,
        target_level != null ? Number(target_level) : null,
        JSON.stringify(decisionPayload),
      ]
    );
    return;
  }
  await query(
    `INSERT INTO promo_pulse_state (
      profile_id, marketplace, action_external_id, our_product_id, external_product_id,
      phase, phase_started_at, target_price, target_level, last_decision, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10::jsonb, CURRENT_TIMESTAMP)`,
    [
      profileId,
      marketplace,
      String(action_external_id),
      ourId,
      extId,
      phase,
      startedAt,
      target_price != null ? Number(target_price) : null,
      target_level != null ? Number(target_level) : null,
      JSON.stringify(decisionPayload),
    ]
  );
}

async function loadAssignmentMaps(profileId) {
  const r = await query(
    `SELECT product_id, user_category_id, organization_id, segment
     FROM promo_pulse_assignments
     WHERE profile_id = $1 AND enabled = true`,
    [profileId]
  );
  const byProduct = new Map();
  const byCategory = new Map();
  const byOrg = new Map();
  for (const row of r.rows || []) {
    if (row.product_id != null) byProduct.set(Number(row.product_id), row.segment);
    if (row.user_category_id != null) byCategory.set(Number(row.user_category_id), row.segment);
    if (row.organization_id != null) byOrg.set(Number(row.organization_id), row.segment);
  }
  return { byProduct, byCategory, byOrg };
}

async function loadProductMetaMap(productIds) {
  const ids = [...new Set((productIds || []).map(Number).filter((n) => n > 0))];
  const map = new Map();
  if (!ids.length) return map;
  const r = await query(
    `SELECT id, user_category_id, organization_id FROM products WHERE id = ANY($1::bigint[])`,
    [ids]
  );
  for (const row of r.rows || []) {
    map.set(Number(row.id), {
      user_category_id: row.user_category_id != null ? Number(row.user_category_id) : null,
      organization_id: row.organization_id != null ? Number(row.organization_id) : null,
    });
  }
  return map;
}

function resolveSegmentFromMaps(productId, meta, maps) {
  if (!productId) return 'normal';
  const pid = Number(productId);
  if (maps.byProduct.has(pid)) return maps.byProduct.get(pid);
  if (meta?.user_category_id != null && maps.byCategory.has(meta.user_category_id)) {
    return maps.byCategory.get(meta.user_category_id);
  }
  if (meta?.organization_id != null && maps.byOrg.has(meta.organization_id)) {
    return maps.byOrg.get(meta.organization_id);
  }
  return 'normal';
}

async function loadAllStatesByProduct(profileId) {
  const r = await query(
    `SELECT marketplace, action_external_id, our_product_id, external_product_id,
            phase, phase_started_at, last_decision
     FROM promo_pulse_state WHERE profile_id = $1`,
    [profileId]
  );
  const byProduct = new Map();
  for (const row of r.rows || []) {
    const pid = row.our_product_id != null ? Number(row.our_product_id) : null;
    if (!pid) continue;
    if (!byProduct.has(pid)) byProduct.set(pid, []);
    byProduct.get(pid).push(row);
  }
  return byProduct;
}

export async function listAssignments(options = {}) {
  const profileId = profileIdOf(options);
  if (!profileId) return [];
  const r = await query(
    `SELECT a.*,
            p.sku AS product_sku,
            p.name AS product_name,
            uc.name AS category_name,
            o.name AS organization_name
     FROM promo_pulse_assignments a
     LEFT JOIN products p ON p.id = a.product_id
     LEFT JOIN user_categories uc ON uc.id = a.user_category_id
     LEFT JOIN organizations o ON o.id = a.organization_id
     WHERE a.profile_id = $1
     ORDER BY a.id DESC
     LIMIT 500`,
    [profileId]
  );
  return r.rows || [];
}

export async function createAssignment(body = {}, options = {}) {
  const profileId = profileIdOf(options);
  if (!profileId) throw new Error('Нет профиля');
  const segment = SEGMENTS.includes(body.segment) ? body.segment : 'normal';
  const productId = body.product_id != null ? Number(body.product_id) : null;
  const organizationId = body.organization_id != null ? Number(body.organization_id) : null;
  const userCategoryId = body.user_category_id != null ? Number(body.user_category_id) : null;
  const targets = [productId, organizationId, userCategoryId].filter((n) => Number.isFinite(n) && n > 0);
  if (targets.length !== 1) throw new Error('Укажите ровно одну цель: товар, категорию или организацию');

  let policyId = body.policy_id != null ? Number(body.policy_id) : null;
  if (!policyId) {
    const pol = await ensureDefaultPolicy(options);
    policyId = pol?.id;
  }
  if (!policyId) throw new Error('Нет политики пульса');

  const r = await query(
    `INSERT INTO promo_pulse_assignments (
      profile_id, policy_id, product_id, organization_id, user_category_id, segment, enabled
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING *`,
    [
      profileId,
      policyId,
      Number.isFinite(productId) && productId > 0 ? productId : null,
      Number.isFinite(organizationId) && organizationId > 0 ? organizationId : null,
      Number.isFinite(userCategoryId) && userCategoryId > 0 ? userCategoryId : null,
      segment,
      body.enabled !== false,
    ]
  );
  return r.rows[0];
}

export async function deleteAssignment(id, options = {}) {
  const profileId = profileIdOf(options);
  const r = await query(
    `DELETE FROM promo_pulse_assignments
     WHERE id = $1 AND ($2::bigint IS NULL OR profile_id = $2)
     RETURNING id`,
    [Number(id), profileId]
  );
  return r.rowCount > 0;
}

export async function listPhaseStates(options = {}) {
  const profileId = profileIdOf(options);
  if (!profileId) return [];
  const r = await query(
    `SELECT s.*, p.name AS product_name, p.sku AS product_sku
     FROM promo_pulse_state s
     LEFT JOIN products p ON p.id = s.our_product_id
     WHERE s.profile_id = $1
     ORDER BY s.updated_at DESC
     LIMIT 300`,
    [profileId]
  );
  return r.rows || [];
}

function actionIsActiveOrSoon(action, now = Date.now()) {
  const start = action.starts_at ? Date.parse(action.starts_at) : NaN;
  const end = action.ends_at ? Date.parse(action.ends_at) : NaN;
  if (Number.isFinite(end) && end < now - 24 * 60 * 60 * 1000) return false;
  if (Number.isFinite(start) && start > now + 14 * 24 * 60 * 60 * 1000) return false;
  return true;
}

function pickActionsForPulse(actions, policy, { preferActionIds = new Set() } = {}) {
  const kinds = new Set(policy.action_kinds || []);
  const max = Math.max(
    1,
    Math.min(200, Number(policy.config?.max_actions_per_mp) || (actions[0]?.marketplace === 'ozon' ? 80 : 40))
  );
  const filtered = (actions || []).filter((a) => {
    if (kinds.size && a.kind && !kinds.has(a.kind)) return false;
    return actionIsActiveOrSoon(a);
  });
  filtered.sort((a, b) => {
    const pa = preferActionIds.has(String(a.external_id)) ? 1 : 0;
    const pb = preferActionIds.has(String(b.external_id)) ? 1 : 0;
    if (pb !== pa) return pb - pa;
    const ta = Number(a.meta?.participating_products_count ?? a.meta?.inPromoActionTotal ?? 0);
    const tb = Number(b.meta?.participating_products_count ?? b.meta?.inPromoActionTotal ?? 0);
    return tb - ta;
  });
  return {
    selected: filtered.slice(0, max),
    truncated: Math.max(0, filtered.length - max),
    total: filtered.length,
  };
}

/**
 * Preview: собрать команды без записи в МП.
 * forcePhase — опционально принудительная фаза для всех (для проверки «что будет в день удара»).
 */
export async function previewPulse(options = {}) {
  const profileId = profileIdOf(options);
  if (!profileId) return { ok: false, error: 'Нет профиля' };

  await ensureDefaultPolicy(options);
  let policy = options.policyId
    ? await getPolicy(options.policyId, options)
    : (await listPolicies(options)).find((p) => p.is_default) || (await listPolicies(options))[0];
  if (!policy) return { ok: false, error: 'Нет политики пульса' };
  if (policy.is_active === false) return { ok: false, error: 'Политика выключена' };

  const marketplaces = Array.isArray(options.marketplaces) && options.marketplaces.length
    ? options.marketplaces.filter((m) => policy.marketplaces.includes(m))
    : policy.marketplaces;

  const forcePhase = options.forcePhase === 'A' || options.forcePhase === 'B' || options.forcePhase === 'C'
    ? options.forcePhase
    : null;

  const scope = { integrationScope: options.integrationScope || { profileId } };
  const commands = [];
  const offersOut = [];
  const errors = [];
  const actionLimits = {};
  const assignmentMaps = await loadAssignmentMaps(profileId);
  const statesByProduct = await loadAllStatesByProduct(profileId);

  for (const mp of marketplaces) {
    let port;
    try {
      port = getPromoPort(mp);
    } catch (e) {
      errors.push({ marketplace: mp, error: e.message });
      continue;
    }
    if (port.ready === false) {
      errors.push({ marketplace: mp, error: 'Адаптер ещё не готов', ready: false });
      continue;
    }
    const caps = port.capabilities();
    let actions = [];
    try {
      actions = await port.listActions(scope);
    } catch (e) {
      errors.push({ marketplace: mp, error: e.message || String(e) });
      continue;
    }

    const stateMap = await loadStateMap(profileId, mp);
    const preferActionIds = new Set([...stateMap.keys()].map((k) => String(k).split(':')[0]));
    const picked = pickActionsForPulse(
      actions.map((a) => ({ ...a, marketplace: mp })),
      policy,
      { preferActionIds }
    );
    actionLimits[mp] = { total: picked.total, used: picked.selected.length, truncated: picked.truncated };
    if (picked.truncated > 0) {
      errors.push({
        marketplace: mp,
        error: `Обработано ${picked.selected.length} из ${picked.total} акций (лимит max_actions_per_mp)`,
        truncated: true,
      });
    }

    for (const action of picked.selected) {
      let participating = [];
      let candidates = [];
      try {
        participating = await port.listParticipating(scope, action.external_id);
        candidates = await port.listCandidates(scope, action.external_id);
      } catch (e) {
        errors.push({ marketplace: mp, action_id: action.external_id, error: e.message || String(e) });
        continue;
      }

      const merged = [
        ...participating.map((o) => ({ ...o, kind: o.kind || action.kind })),
        ...candidates.map((o) => ({ ...o, kind: o.kind || action.kind })),
      ];
      const productMeta = await loadProductMetaMap(merged.map((o) => o.our_product_id));

      for (const offer of merged) {
        if (!offer.our_product_id) continue;
        const st = stateMap.get(stateKey(action.external_id, offer));
        let phase = forcePhase || st?.phase || 'A';
        let phaseStarted = st?.phase_started_at || new Date().toISOString();
        if (!forcePhase) {
          const adv = advancePhase({
            phase,
            phaseStartedAt: phaseStarted,
            phaseADays: policy.phase_a_days,
            phaseBDays: policy.phase_b_days,
            phaseCDays: phaseCDaysOf(policy),
          });
          phase = adv.phase;
          phaseStarted = adv.phase_started_at;
        }
        const meta = productMeta.get(Number(offer.our_product_id));
        const segment = resolveSegmentFromMaps(offer.our_product_id, meta, assignmentMaps);
        const daysInB30d = daysInBOver30d({
          states: statesByProduct.get(Number(offer.our_product_id)) || [],
        });
        const decision = evaluateOffer({
          offer: { ...offer, kind: offer.kind || action.kind },
          policy,
          segment,
          phase,
          capabilities: caps,
          daysInB30d,
          isNewProduct: segment === 'new',
        });
        commands.push({
          ...decision,
          action_title: action.title,
          action_kind: action.kind,
          segment,
          days_in_b_30d: Math.round(daysInB30d * 10) / 10,
          offer_name: offer.meta?.name || null,
          sku: offer.meta?.offer_id || null,
          floor: offer.floor ?? null,
          list_price: offer.list_price ?? null,
          max_action_price: offer.max_action_price ?? offer.meta?.max_action_price ?? null,
          phase_started_at: phaseStarted,
        });
        offersOut.push({
          marketplace: mp,
          action_id: action.external_id,
          action_title: action.title,
          action_kind: action.kind,
          our_product_id: offer.our_product_id,
          external_product_id: offer.external_product_id,
          participating: offer.participating,
          phase,
          phase_started_at: phaseStarted,
          segment,
          days_in_b_30d: Math.round(daysInB30d * 10) / 10,
          entry_price: offer.entry_price,
          floor: offer.floor,
          profit_rub: offer.profit_rub,
          markup_rub: offer.markup_rub,
          decision: decision.type,
          reason: decision.reason,
          target_price: decision.price,
          target_level: decision.level,
        });
      }
    }
  }

  const counts = commands.reduce((acc, c) => {
    acc[c.type] = (acc[c.type] || 0) + 1;
    return acc;
  }, {});

  return {
    ok: true,
    dryRun: true,
    policy,
    marketplaces,
    forcePhase,
    ports: listPromoPorts(),
    actionLimits,
    counts,
    commands: commands.filter((c) => c.type !== 'skip'),
    all: offersOut,
    errors,
  };
}

/**
 * Прогон: preview → apply (если не dry-run) → лог + upsert фаз.
 * persistState по умолчанию true (календарь фаз двигается и в dry-run при «Сохранить прогон»).
 */
export async function runPulse(options = {}) {
  const preview = await previewPulse(options);
  if (!preview.ok) return preview;

  const profileId = profileIdOf(options);
  // Live только если в политике снят dry_run и в запросе явно dryRun=false
  let dryRun = preview.policy.dry_run !== false;
  if (options.dryRun === true) dryRun = true;
  if (options.dryRun === false && preview.policy.dry_run === false) dryRun = false;
  const persistState = options.persistState !== false;
  const scope = { integrationScope: options.integrationScope || { profileId } };

  const runIns = await query(
    `INSERT INTO promo_pulse_runs (profile_id, policy_id, dry_run, marketplaces, status, counts, finished_at)
     VALUES ($1,$2,$3,$4::jsonb,'running',$5::jsonb, NULL)
     RETURNING id`,
    [
      profileId,
      preview.policy.id,
      dryRun,
      JSON.stringify(preview.marketplaces),
      JSON.stringify(preview.counts || {}),
    ]
  );
  const runId = runIns.rows[0].id;

  const actionable = preview.commands || [];
  const applyResults = [];
  let applyOk = true;

  for (const mp of preview.marketplaces) {
    let port;
    try {
      port = getPromoPort(mp);
    } catch (e) {
      applyOk = false;
      applyResults.push({ marketplace: mp, ok: false, error: e.message });
      continue;
    }
    const batch = actionable.filter((c) => c.marketplace === mp);
    if (!batch.length) continue;
    const applied = await port.apply(scope, batch, { dryRun });
    if (applied.ok === false) applyOk = false;
    for (const row of applied.results || batch) {
      applyResults.push(row);
      await query(
        `INSERT INTO promo_pulse_run_items (
          run_id, marketplace, action_external_id, our_product_id, external_product_id,
          command_type, command, result, ok, error
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
        [
          runId,
          mp,
          row.action_id != null ? String(row.action_id) : null,
          row.our_product_id ?? null,
          row.external_product_id != null ? String(row.external_product_id) : null,
          row.type || null,
          JSON.stringify(row),
          JSON.stringify(row),
          row.ok !== false,
          row.error || null,
        ]
      );
    }
  }

  if (persistState && !options.forcePhase) {
    for (const row of preview.all || []) {
      if (!row.our_product_id && !row.external_product_id) continue;
      await upsertPulseState(profileId, {
        marketplace: row.marketplace,
        action_external_id: row.action_id,
        our_product_id: row.our_product_id,
        external_product_id: row.external_product_id,
        phase: row.phase,
        phase_started_at: row.phase_started_at || new Date().toISOString(),
        target_price: row.target_price,
        target_level: row.target_level,
        last_decision: {
          type: row.decision,
          reason: row.reason,
          dryRun,
          at: new Date().toISOString(),
        },
      });
    }
  }

  await query(
    `UPDATE promo_pulse_runs
     SET status = $2, counts = $3::jsonb, finished_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      runId,
      applyOk ? 'completed' : 'completed_with_errors',
      JSON.stringify(preview.counts || {}),
    ]
  );

  return {
    ...preview,
    runId,
    dryRun,
    applied: !dryRun,
    applyOk,
    applyResults: dryRun ? undefined : applyResults,
    notice: dryRun
      ? 'Прогон сохранён (dry-run). В МП ничего не отправляли.'
      : applyOk
        ? 'Прогон выполнен: команды отправлены на МП.'
        : 'Прогон выполнен с ошибками — смотрите детали apply.',
  };
}

/** Фоновый прогон по всем профилям с активной политикой. */
export async function runPulseForAllProfiles(options = {}) {
  const r = await query(
    `SELECT DISTINCT profile_id FROM promo_pulse_policies WHERE is_active = true`
  );
  const ids = (r.rows || []).map((row) => Number(row.profile_id)).filter((n) => n > 0);
  const out = [];
  for (const profileId of ids) {
    try {
      const policies = await listPolicies({ profileId });
      const policy = policies.find((p) => p.is_default && p.is_active) || policies.find((p) => p.is_active);
      if (!policy) continue;
      const dryRun = options.forceLive === true ? false : policy.dry_run !== false;
      const result = await runPulse({
        profileId,
        integrationScope: { profileId },
        policyId: policy.id,
        dryRun,
        persistState: true,
      });
      out.push({ profileId, ok: result.ok, dryRun, runId: result.runId, counts: result.counts, error: result.error });
    } catch (e) {
      out.push({ profileId, ok: false, error: e.message || String(e) });
    }
  }
  return out;
}

export async function listRuns(options = {}) {
  const profileId = profileIdOf(options);
  if (!profileId) return [];
  const r = await query(
    `SELECT id, policy_id, dry_run, marketplaces, status, counts, started_at, finished_at
     FROM promo_pulse_runs WHERE profile_id = $1
     ORDER BY started_at DESC LIMIT 50`,
    [profileId]
  );
  return r.rows || [];
}

export async function getRun(id, options = {}) {
  const profileId = profileIdOf(options);
  const r = await query(`SELECT * FROM promo_pulse_runs WHERE id = $1 LIMIT 1`, [Number(id)]);
  const run = r.rows?.[0];
  if (!run) return null;
  if (profileId && Number(run.profile_id) !== profileId) return null;
  const items = await query(
    `SELECT * FROM promo_pulse_run_items WHERE run_id = $1 ORDER BY id ASC LIMIT 2000`,
    [run.id]
  );
  return { ...run, items: items.rows || [] };
}

export { listPromoPorts };
