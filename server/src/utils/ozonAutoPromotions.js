/**
 * Флаг «запретить авто-добавление в акции Ozon» в config кабинета / integrations.
 */

export function isOzonBlockAutoPromotionsEnabled(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  const v = cfg.block_ozon_auto_promotions ?? cfg.blockOzonAutoPromotions;
  return v === true || v === 'true' || v === '1' || v === 1;
}

export function pickOzonCredentials(cfg) {
  if (!cfg || typeof cfg !== 'object') return { client_id: null, api_key: null };
  return {
    client_id: cfg.client_id ?? cfg.clientId ?? null,
    api_key: cfg.api_key ?? cfg.apiKey ?? null,
  };
}
