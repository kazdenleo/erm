/**
 * Integrations Service
 * Бизнес-логика для работы с настройками интеграций
 */

import repositoryFactory from '../config/repository-factory.js';
import { readData, writeData } from '../utils/storage.js';
import logger from '../utils/logger.js';
import { query, transaction } from '../config/database.js';
import { getYandexHttpsAgent, formatYandexNetworkError } from '../utils/yandex-https-agent.js';
import { addRuntimeNotification } from '../utils/runtime-notifications.js';

class IntegrationsService {
  constructor() {
    this.repository = repositoryFactory.getIntegrationsRepository();
    this.usePostgreSQL = repositoryFactory.isUsingPostgreSQL();
    this.cacheRepository = this.usePostgreSQL ? repositoryFactory.getCacheEntriesRepository() : null;
  }
  
  async _getOldRepository() {
    if (this.usePostgreSQL) return null;
    const module = await import('../repositories/integrations.repository.js');
    return module.default;
  }

  _isTruthy(v) {
    return v === true || v === 'true' || v === '1' || v === 1;
  }

  /** Справочник Ozon в ответе attribute: поле может называться по-разному. */
  _ozonEffectiveDictionaryId(a) {
    if (!a || typeof a !== 'object') return 0;
    const keys = ['dictionary_id', 'attribute_dictionary_id', 'dictionaryId', 'dictionaryID'];
    for (const k of keys) {
      const v = a[k];
      if (v == null || v === '') continue;
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const raw = a.dictionary_id;
    if (raw != null && raw !== '') {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  }

  _safeParseJsonMaybe(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value; // jsonb обычно уже объект
    const s = String(value).trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch (_) { return null; }
  }

  _dateFromNowMs(ms) {
    const d = new Date(Date.now() + ms);
    return d.toISOString();
  }

  async _cacheGet({ cache_type, cache_key }) {
    if (!this.cacheRepository) return null;
    const entry = await this.cacheRepository.findByTypeAndKey(cache_type, cache_key);
    if (!entry) return null;
    // если expires_at <= now — считаем промахом
    if (entry.expires_at) {
      const exp = new Date(entry.expires_at);
      if (!Number.isNaN(exp.getTime()) && exp.getTime() <= Date.now()) return null;
    }
    return this._safeParseJsonMaybe(entry.cache_value);
  }

  async _cacheSet({ cache_type, cache_key, cache_value, ttl_ms }) {
    if (!this.cacheRepository) return null;
    const expires_at = ttl_ms != null ? this._dateFromNowMs(ttl_ms) : null;
    return await this.cacheRepository.upsert({ cache_type, cache_key, cache_value, expires_at });
  }

  /**
   * Получить настройки маркетплейса
   */
  async getMarketplaceConfig(type, { profileId = null } = {}) {
    if (!['ozon', 'wildberries', 'yandex'].includes(type)) {
      const err = new Error('Неизвестный тип маркетплейса');
      err.statusCode = 400;
      throw err;
    }

    if (repositoryFactory.isUsingPostgreSQL()) {
      const integration = await this.repository.findByCode(type, profileId);
      return integration ? integration.config : {};
    } else {
      // Старое хранилище
      return await readData(type) || {};
    }
  }

  _parseMaybeDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  _computeExpiry(expiresAt) {
    const d = this._parseMaybeDate(expiresAt);
    if (!d) return { expires_at: null, days_left: null, expired: null };
    const msLeft = d.getTime() - Date.now();
    const daysLeft = Math.floor(msLeft / (1000 * 60 * 60 * 24));
    return {
      expires_at: d.toISOString(),
      days_left: daysLeft,
      expired: msLeft < 0
    };
  }

  /** Нормализация токена WB: убрать только пробелы и BOM, не трогать символы токена (JWT/base64: буквы, цифры, . - _ + / =). */
  _normalizeWbToken(apiKey) {
    if (apiKey == null) return '';
    return String(apiKey).replace(/\s+/g, '').replace(/\uFEFF/g, '').trim();
  }

  _safeTokenMeta(token) {
    const t = token == null ? '' : String(token);
    const normalized = this._normalizeWbToken(t);
    const dotCount = (normalized.match(/\./g) || []).length;
    const looksJwt = dotCount >= 2;
    let jwtHeaderOk = null;
    let jwtAlg = null;
    if (looksJwt) {
      const headerPart = normalized.split('.')[0] || '';
      try {
        const b64 = headerPart.replace(/-/g, '+').replace(/_/g, '/');
        const pad = '='.repeat((4 - (b64.length % 4)) % 4);
        const json = Buffer.from(b64 + pad, 'base64').toString('utf8');
        const obj = JSON.parse(json);
        jwtHeaderOk = true;
        jwtAlg = obj?.alg || null;
      } catch (_) {
        jwtHeaderOk = false;
      }
    }
    return {
      length: normalized.length,
      dot_count: dotCount,
      looks_jwt: looksJwt,
      jwt_header_decodable: jwtHeaderOk,
      jwt_alg: jwtAlg
    };
  }

  _tokenStatusCacheKey(profileId) {
    return String(profileId ?? 'default');
  }

  /** Последняя сохранённая проверка: byProfile[profileId][type] или legacy плоский cache[type]. */
  _readTokenStatusFromCache(cache, profileId, type) {
    const k = this._tokenStatusCacheKey(profileId);
    const row = cache?.byProfile?.[k]?.[type];
    if (row) return row;
    if (cache?.[type] && (profileId == null || k === 'default')) return cache[type];
    return null;
  }

  _writeTokenStatusToCache(cache, profileId, type, status) {
    cache.byProfile = cache.byProfile || {};
    const k = this._tokenStatusCacheKey(profileId);
    cache.byProfile[k] = cache.byProfile[k] || {};
    cache.byProfile[k][type] = status;
  }

  /**
   * Проверка токена маркетплейса (валидность + срок, если задан в настройках).
   * Возвращает объект статуса и сохраняет его в кэш для уведомлений.
   * @param {'ozon'|'wildberries'|'yandex'} type
   * @param {{ profileId?: number|string|null }} [opts] — аккаунт (multi-tenant)
   */
  async getMarketplaceTokenStatus(type, { profileId = null } = {}) {
    if (!['ozon', 'wildberries', 'yandex'].includes(type)) {
      const err = new Error('Неизвестный тип маркетплейса');
      err.statusCode = 400;
      throw err;
    }

    const checkedAt = new Date().toISOString();
    const cfg = await this.getMarketplaceConfig(type, { profileId });
    const expiresAt = cfg.token_expires_at || cfg.api_key_expires_at || cfg.expires_at || null;
    const expiry = this._computeExpiry(expiresAt);

    let valid = false;
    let message = '';
    const checks = [];
    try {
      if (type === 'ozon') {
        // лёгкий запрос, который проверяет Client-Id/Api-Key
        await this._ozonApiPost('/v1/description-category/tree', { language: 'DEFAULT' }, { profileId });
        checks.push({ scope: 'ozon_v1', valid: true, message: 'Ozon: v1 OK (categories)' });

        // Доп. проверка боевого эндпоинта цен (v5) — он нужен для комиссий/мин. цен.
        // Берём любой offer_id из БД (если есть), чтобы проверить именно рабочий контур.
        let probeOfferId = null;
        try {
          if (repositoryFactory.isUsingPostgreSQL()) {
            const r = await query(
              `SELECT TRIM(ps.sku) AS offer_id
               FROM product_skus ps
               INNER JOIN products p ON p.id = ps.product_id
               WHERE ps.marketplace = 'ozon' AND ps.sku IS NOT NULL AND TRIM(ps.sku) <> ''
                 AND ($1::bigint IS NULL OR p.profile_id = $1)
               ORDER BY ps.product_id ASC
               LIMIT 1`,
              [profileId]
            );
            probeOfferId = r.rows?.[0]?.offer_id ? String(r.rows[0].offer_id).trim() : null;
          } else {
            const r = await query(
              `SELECT TRIM(sku) AS offer_id
               FROM product_skus
               WHERE marketplace = 'ozon' AND sku IS NOT NULL AND TRIM(sku) <> ''
               ORDER BY product_id ASC
               LIMIT 1`
            );
            probeOfferId = r.rows?.[0]?.offer_id ? String(r.rows[0].offer_id).trim() : null;
          }
        } catch (_) {
          // таблицы может не быть — не считаем это проблемой токена
        }

        if (probeOfferId) {
          try {
            await this._ozonApiPost('/v5/product/info/prices', {
              cursor: '',
              filter: { offer_id: [probeOfferId], visibility: 'ALL' },
              limit: 1
            }, { profileId });
            checks.push({ scope: 'ozon_v5_prices', valid: true, message: 'Ozon: v5 OK (prices)' });
            valid = true;
            message = 'Ozon: ключ валиден';
          } catch (e) {
            const m = String(e?.message || '');
            const deactivated = m.toLowerCase().includes('api-key is deactivated');
            checks.push({
              scope: 'ozon_v5_prices',
              valid: false,
              message: deactivated
                ? 'Ozon: API ключ деактивирован (v5 prices)'
                : `Ozon: v5 prices check failed: ${m.slice(0, 140)}`
            });
            valid = false;
            message = deactivated ? 'Ozon: API ключ деактивирован' : 'Ozon: ключ не проходит проверку (v5 prices)';

            if (deactivated) {
              await addRuntimeNotification({
                type: 'marketplace_api_error',
                severity: 'error',
                source: 'integrations.token-status',
                marketplace: 'ozon',
                title: 'Ozon: API ключ деактивирован',
                message:
                  'Ozon Seller API вернул "Api-key is deactivated" при проверке v5/product/info/prices. Комиссии и минимальные цены могут считаться по старым данным/кэшу.',
                meta: profileId != null ? { profile_id: profileId } : undefined
              });
            }
          }
        } else {
          checks.push({ scope: 'ozon_v5_prices', valid: true, message: 'Ozon: v5 prices probe skipped (no offer_id to test)' });
          valid = true;
          message = 'Ozon: ключ валиден';
        }
      } else if (type === 'wildberries') {
        const fetchWithTimeout = async (url, init, timeoutMs = 8000) => {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), timeoutMs);
          try {
            return await fetch(url, { ...(init || {}), signal: controller.signal });
          } finally {
            clearTimeout(t);
          }
        };

        // WB: официальная проверка токена через GET /ping для каждого сервиса
        // (проверяет доставку запроса, валидность токена и совпадение категории токена с сервисом)
        const cfgWb = await this.getMarketplaceConfig('wildberries', { profileId });
        const apiKey = this._normalizeWbToken(cfgWb?.api_key);
        const token_meta = this._safeTokenMeta(apiKey);
        // WB: токен добавляется в заголовок Authorization. Для /ping есть строгий лимит (3 запроса / 30 секунд на домен),
        // поэтому не делаем ретраи с разными форматами заголовка — отправляем один запрос с Bearer.
        const authHeader = apiKey ? `Bearer ${apiKey}` : '';

        const pingServices = [
          { scope: 'content', label: 'Контент', url: 'https://content-api.wildberries.ru/ping' },
          { scope: 'marketplace', label: 'Маркетплейс', url: 'https://marketplace-api.wildberries.ru/ping' },
          { scope: 'statistics', label: 'Статистика', url: 'https://statistics-api.wildberries.ru/ping' },
          { scope: 'common', label: 'Тарифы/Общее', url: 'https://common-api.wildberries.ru/ping' }
        ];

        for (const svc of pingServices) {
          const check = { scope: svc.scope, valid: false, message: '' };
          try {
            const response = await fetchWithTimeout(svc.url, {
              method: 'GET',
              headers: { 'Accept': 'application/json', 'Authorization': authHeader }
            });
            if (response?.ok) {
              const text = await response.text().catch(() => '');
              let body = {};
              try { body = text ? JSON.parse(text) : {}; } catch (_) {}
              const statusOk = body?.Status === 'OK' || body?.status === 'OK';
              check.valid = true;
              check.message = statusOk ? `${svc.label}: OK` : `${svc.label}: 200`;
            } else {
              const text = await response.text().catch(() => '');
              let detail = '';
              try {
                const j = text ? JSON.parse(text) : {};
                detail = String(j?.detail || j?.message || '').toLowerCase();
              } catch (_) {}
              if (response?.status === 429) {
                check.message = 'Лимит /ping: слишком много запросов (429). Подождите ~30 секунд и повторите проверку.';
              } else if (response?.status === 401 && detail.includes('token scope not allowed')) {
                check.message = 'Токен принят, но нет прав на эту категорию API (token scope not allowed). Перевыпустите токен в ЛК WB с нужными категориями (например: Контент / Маркетплейс / Статистика / Финансы и т.д.).';
              } else if (response?.status === 401 && (detail.includes('malformed') || detail.includes('base64'))) {
                const formatOk = token_meta?.looks_jwt && token_meta?.jwt_header_decodable;
                check.message = formatOk
                  ? 'Токен в формате JWT (ES256), структура корректна. WB возвращает ошибку — возможно, проверка подписи/срока на стороне WB.'
                  : 'Токен не принят (ошибка формата). Скопируйте ключ целиком из ЛК WB: Профиль → Настройки → Доступ к API.';
              } else {
                check.message = `HTTP ${response?.status || '?'}${text ? ': ' + text.substring(0, 150) : ''}`;
              }
            }
          } catch (e) {
            check.message = e?.name === 'AbortError'
              ? 'таймаут'
              : (e?.message || 'ошибка').substring(0, 120);
          }
          checks.push(check);
        }

        // Если все /ping вернули 401 (формат), пробуем реальный запрос к API тарифов — он может принять токен, который /ping не принимает
        const allPingFailed = checks.length > 0 && checks.every((c) => !c.valid);
        if (allPingFailed && apiKey) {
          const fallbackCheck = { scope: 'tariffs', valid: false, message: '' };
          try {
            const date = new Date().toISOString().split('T')[0];
            const url = `https://common-api.wildberries.ru/api/v1/tariffs/box?date=${date}`;
            const res = await fetchWithTimeout(url, {
              method: 'GET',
              headers: { 'Accept': 'application/json', 'Authorization': authHeader }
            });
            if (res.ok) {
              fallbackCheck.valid = true;
              fallbackCheck.message = 'Тарифы API: OK (токен принят)';
            } else if (res.status === 429) {
              fallbackCheck.message = 'Лимит WB API (429). Подождите и повторите.';
            } else {
              fallbackCheck.message = 'Тарифы API: недоступен с этим токеном';
            }
          } catch (e) {
            fallbackCheck.message = e?.name === 'AbortError' ? 'таймаут' : (e?.message || 'ошибка').substring(0, 80);
          }
          checks.push(fallbackCheck);
        }

        const anyValid = checks.some((c) => c.valid === true);
        valid = anyValid;
        const allValid = checks.every((c) => c.valid === true);
        const tariffsOk = checks.some((c) => c.scope === 'tariffs' && c.valid);
        const malformedHint = checks.some((c) => c.message && (c.message.includes('Токен не принят') || c.message.includes('ошибка формата')));
        const scopeNotAllowedHint = checks.some((c) => (c.message || '').includes('token scope not allowed'));
        if (valid) {
          message = allValid
            ? 'Wildberries: токен валиден (все проверенные сервисы)'
            : (tariffsOk ? 'Wildberries: /ping не принимает этот токен, но тарифы доступны — ключ рабочий.' : 'Wildberries: токен валиден (см. детали — часть методов доступна)');
        } else {
          const formatOk = token_meta?.looks_jwt && token_meta?.jwt_header_decodable;
          message = scopeNotAllowedHint
            ? 'Wildberries: токен без нужных прав (token scope not allowed). Перевыпустите токен в ЛК WB и выберите требуемые категории API.'
            : malformedHint
            ? (formatOk
              ? 'Wildberries: токен в формате JWT (ES256) корректен, но WB его не принимает. Возможно, проверка подписи или срока на стороне WB. Попробуйте новый токен в ЛК WB или поддержку WB.'
              : 'Wildberries: токен не принят. Проверьте ключ в ЛК WB: Профиль → Настройки → Доступ к API, вставьте целиком.')
            : 'Wildberries: токен не проходит проверку (см. детали)';
        }
      } else if (type === 'yandex') {
        // проверка токена через POST /v2/auth/token (только Api-Key, без доступа к категориям)
        const yandexCheck = await this._validateYandexToken(cfg?.api_key ?? cfg?.apiKey);
        valid = yandexCheck.valid;
        message = yandexCheck.message;
        if (yandexCheck.scopes?.length) {
          checks.push({ scope: 'yandex', valid: true, message: `Доступы: ${yandexCheck.scopes.join(', ')}` });
        } else {
          checks.push({ scope: 'yandex', valid, message });
        }
      }
    } catch (e) {
      valid = false;
      message = e?.message || 'Токен невалиден';
    }

    const status = {
      marketplace: type,
      profile_id: profileId != null && profileId !== '' ? Number(profileId) : null,
      valid,
      checked_at: checkedAt,
      message,
      checks,
      ...expiry
    };

    try {
      const cache = (await readData('tokenStatusCache')) || {};
      this._writeTokenStatusToCache(cache, profileId, type, status);
      await writeData('tokenStatusCache', cache);
    } catch (cacheErr) {
      logger.warn('[Integrations Service] Failed to write tokenStatusCache:', cacheErr?.message);
    }

    return status;
  }

  /**
   * Уведомления по токенам маркетплейсов (невалиден / истёк / скоро истечёт).
   * Использует кэш последней проверки + даты окончания из настроек.
   */
  async getTokenNotifications(options = {}) {
    const warnDays = Number(options.warn_days ?? 10);
    const profileId = options.profileId ?? null;
    const cache = (await readData('tokenStatusCache')) || {};
    const integrations = await this.getAll(
      repositoryFactory.isUsingPostgreSQL() && profileId != null && profileId !== ''
        ? { profileId }
        : {}
    );
    const byCode = new Map(integrations.map((i) => [i.code, i]));
    const marketplaces = ['ozon', 'wildberries', 'yandex'];
    const out = [];

    for (const code of marketplaces) {
      const integration = byCode.get(code);
      const cfg = integration?.config || {};
      const expiresAt = cfg.token_expires_at || cfg.api_key_expires_at || cfg.expires_at || null;
      const expiry = this._computeExpiry(expiresAt);
      const last = this._readTokenStatusFromCache(cache, profileId, code);

      const idSuffix = profileId != null && profileId !== '' ? `_${profileId}` : '';
      if (expiry.expires_at && expiry.expired) {
        out.push({
          id: `token_expired_${code}${idSuffix}`,
          type: 'token_expired',
          marketplace: code,
          severity: 'error',
          title: 'Истёк токен маркетплейса',
          message: `${code}: токен истёк (${expiry.expires_at}).`,
          expires_at: expiry.expires_at,
          days_left: expiry.days_left,
          checked_at: last?.checked_at || null,
          valid: last?.valid ?? null
        });
      } else if (expiry.expires_at && expiry.days_left != null && expiry.days_left <= warnDays) {
        out.push({
          id: `token_expires_soon_${code}${idSuffix}`,
          type: 'token_expires_soon',
          marketplace: code,
          severity: 'warn',
          title: 'Скоро истечёт токен маркетплейса',
          message: `${code}: токен истечёт через ${expiry.days_left} дн. (${expiry.expires_at}).`,
          expires_at: expiry.expires_at,
          days_left: expiry.days_left,
          checked_at: last?.checked_at || null,
          valid: last?.valid ?? null
        });
      }

      if (last && last.valid === false) {
        out.push({
          id: `token_invalid_${code}${idSuffix}`,
          type: 'token_invalid',
          marketplace: code,
          severity: 'error',
          title: 'Токен маркетплейса не проходит проверку',
          message: last.message || `${code}: токен невалиден`,
          checked_at: last.checked_at || null,
          valid: false
        });
      }
    }

    // Сертификаты: истёкшие и истекающие
    try {
      if (repositoryFactory.isUsingPostgreSQL()) {
        const r = await query(
          `SELECT c.id, c.certificate_number, c.valid_to, c.valid_from,
                  b.name AS brand_name,
                  string_agg(DISTINCT uc.name, ', ' ORDER BY uc.name) AS user_category_name
           FROM certificates c
           LEFT JOIN brands b ON b.id = c.brand_id
           LEFT JOIN certificate_user_categories cuc ON cuc.certificate_id = c.id
           LEFT JOIN user_categories uc ON uc.id = cuc.user_category_id
           WHERE c.valid_to IS NOT NULL
             AND c.valid_to <= (CURRENT_DATE + ($1::int * INTERVAL '1 day'))
           GROUP BY c.id, c.certificate_number, c.valid_to, c.valid_from, b.name
           ORDER BY c.valid_to ASC`,
          [warnDays]
        );
        for (const row of r.rows || []) {
          const dt = row.valid_to ? String(row.valid_to).slice(0, 10) : null;
          // days left
          let daysLeft = null;
          try {
            const d = new Date(`${dt}T00:00:00`);
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            daysLeft = Math.floor((d.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
          } catch (_) {}
          const expired = daysLeft != null ? daysLeft < 0 : false;
          const title = expired ? 'Истёк сертификат' : 'Скоро истечёт сертификат';
          const severity = expired ? 'error' : 'warn';
          const scope = [row.brand_name, row.user_category_name].filter(Boolean).join(' · ');
          out.push({
            id: `certificate_${row.id}`,
            type: expired ? 'certificate_expired' : 'certificate_expires_soon',
            severity,
            title,
            message: `${row.certificate_number}${scope ? ` (${scope})` : ''}: срок до ${dt}${daysLeft != null && !expired ? `, осталось ${daysLeft} дн.` : ''}.`,
            expires_at: dt,
            days_left: daysLeft,
            certificate_id: row.id
          });
        }
      } else {
        const list = await readData('certificates');
        const arr = Array.isArray(list) ? list : [];
        const today = new Date();
        const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        for (const c of arr) {
          const dt = c?.valid_to ? String(c.valid_to).slice(0, 10) : null;
          if (!dt) continue;
          const d = new Date(`${dt}T00:00:00`);
          const daysLeft = Math.floor((d.getTime() - t0.getTime()) / (24 * 60 * 60 * 1000));
          if (daysLeft > warnDays) continue;
          const expired = daysLeft < 0;
          out.push({
            id: `certificate_${c.id}`,
            type: expired ? 'certificate_expired' : 'certificate_expires_soon',
            severity: expired ? 'error' : 'warn',
            title: expired ? 'Истёк сертификат' : 'Скоро истечёт сертификат',
            message: `${c.certificate_number}: срок до ${dt}${!expired ? `, осталось ${daysLeft} дн.` : ''}.`,
            expires_at: dt,
            days_left: daysLeft,
            certificate_id: c.id
          });
        }
      }
    } catch (e) {
      // ignore certificates notifications errors
    }

    // Runtime notifications (фоновые задачи, ошибки интеграций и т.д.)
    try {
      const runtime = await (await import('../utils/runtime-notifications.js')).getRuntimeNotifications();
      if (Array.isArray(runtime) && runtime.length) {
        // Не показываем "залипшие" старые ошибки по маркетплейсам, если последняя проверка токена успешна.
        // Иначе после обновления ключа/токена пользователь будет видеть исторические ошибки как будто они актуальны.
        const isMarketplaceRecovered = (code) => {
          const last = cache?.[code];
          return !!(last && last.valid === true);
        };
        const shouldHideAsStale = (n) => {
          if (!n || n.type !== 'marketplace_api_error') return false;
          const mp = n.marketplace;
          if (!mp) return false;
          if (!isMarketplaceRecovered(mp)) return false;
          const title = String(n.title || '');
          // WB: access token expired — если токен уже валиден, считаем уведомление историческим.
          if (mp === 'wildberries' && title.toLowerCase().includes('access token expired')) return true;
          // Ozon: Api-key is deactivated — если ключ уже валиден, считаем уведомление историческим.
          if (mp === 'ozon' && title.toLowerCase().includes('api ключ деактивирован')) return true;
          return false;
        };
        out.push(...runtime.filter((n) => !shouldHideAsStale(n)));
      }
    } catch (_) {}

    // сортировка: error выше warn
    const prio = { error: 0, warn: 1, info: 2 };
    out.sort((a, b) => {
      const sa = (prio[a.severity] ?? 9) - (prio[b.severity] ?? 9);
      if (sa !== 0) return sa;
      const ta = Date.parse(a.created_at || a.checked_at || a.expires_at || '') || 0;
      const tb = Date.parse(b.created_at || b.checked_at || b.expires_at || '') || 0;
      return tb - ta;
    });
    return out;
  }

  /**
   * Сохранить настройки маркетплейса.
   * При добавлении API-ключа без даты окончания автоматически ставится срок 180 дней.
   */
  async saveMarketplaceConfig(type, config, { profileId = null } = {}) {
    if (!['ozon', 'wildberries', 'yandex'].includes(type)) {
      const err = new Error('Неизвестный тип маркетплейса');
      err.statusCode = 400;
      throw err;
    }

    config = { ...config };
    if (type === 'wildberries' && config.api_key != null) {
      config.api_key = this._normalizeWbToken(config.api_key) || config.api_key;
    }
    const hasKey = config.api_key != null && String(config.api_key).trim() !== '';
    const hasExpiry = !!(config.token_expires_at || config.api_key_expires_at || config.expires_at);
    if (hasKey && !hasExpiry) {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 180);
      config.token_expires_at = expiresAt.toISOString().slice(0, 10);
    }

    // Валидация обязательных полей
    if (type === 'ozon') {
      if (!config.client_id || !config.api_key) {
        const err = new Error('Для Ozon требуется client_id и api_key');
        err.statusCode = 400;
        throw err;
      }
    } else if (type === 'wildberries') {
      if (!config.api_key) {
        const err = new Error('Для Wildberries требуется api_key');
        err.statusCode = 400;
        throw err;
      }
    } else if (type === 'yandex') {
      if (!config.api_key || !config.campaign_id) {
        const err = new Error('Для Yandex Market требуется api_key и campaign_id');
        err.statusCode = 400;
        throw err;
      }
    }

    if (repositoryFactory.isUsingPostgreSQL()) {
      let integration = await this.repository.findByCode(type, profileId);
      if (integration) {
        await this.repository.updateConfig(integration.id, config);
      } else {
        await this.repository.create({
          profile_id: profileId,
          type: 'marketplace',
          name: type === 'ozon' ? 'Ozon' : type === 'wildberries' ? 'Wildberries' : 'Yandex Market',
          code: type,
          config: config,
          is_active: true
        });
      }
      return { success: true, type, config };
    } else {
      await writeData(type, config);
      return { success: true, type, config };
    }
  }

  /**
   * Получить настройки поставщика
   */
  async getSupplierConfig(type) {
    if (!['mikado', 'moskvorechie'].includes(type)) {
      const err = new Error('Неизвестный тип поставщика');
      err.statusCode = 400;
      throw err;
    }

    if (repositoryFactory.isUsingPostgreSQL()) {
      const integration = await this.repository.findByCode(type);
      return integration ? integration.config : {};
    } else {
      // Старое хранилище
      return await readData(type) || {};
    }
  }

  /**
   * Сохранить настройки поставщика
   */
  async saveSupplierConfig(type, config) {
    if (!['mikado', 'moskvorechie'].includes(type)) {
      const err = new Error('Неизвестный тип поставщика');
      err.statusCode = 400;
      throw err;
    }

    // Валидация обязательных полей
    if (type === 'mikado') {
      if (!config.user_id || !config.password) {
        const err = new Error('Для Mikado требуется user_id и password');
        err.statusCode = 400;
        throw err;
      }
    } else if (type === 'moskvorechie') {
      if (!config.user_id || (!config.apiKey && !config.password)) {
        const err = new Error('Для Moskvorechie требуется user_id и apiKey (или password)');
        err.statusCode = 400;
        throw err;
      }
    }

    if (repositoryFactory.isUsingPostgreSQL()) {
      let integration = await this.repository.findByCode(type);
      if (integration) {
        await this.repository.updateConfig(integration.id, config);
      } else {
        await this.repository.create({
          type: 'supplier',
          name: type === 'mikado' ? 'Mikado' : 'Moskvorechie',
          code: type,
          config: config,
          is_active: true
        });
      }
      return { success: true, type };
    } else {
      // Старое хранилище
      await writeData(type, config);
      return { success: true, type };
    }
  }

  /**
   * Получить все интеграции (полный список с метаданными)
   * @param {{ profileId?: number|string|null }} [options] — при PostgreSQL: только интеграции аккаунта
   */
  async getAll({ profileId = null } = {}) {
    if (repositoryFactory.isUsingPostgreSQL()) {
      const opts = {};
      if (profileId != null && profileId !== '') opts.profileId = profileId;
      return await this.repository.findAll(opts);
    } else {
      // Старое хранилище - возвращаем структурированные данные
      const [ozon, wb, ym, mikado, moskvorechie] = await Promise.all([
        readData('ozon'),
        readData('wildberries'),
        readData('yandex'),
        readData('mikado'),
        readData('moskvorechie')
      ]);
      
      return [
        { id: 1, type: 'marketplace', name: 'Ozon', code: 'ozon', config: ozon || {}, is_active: true },
        { id: 2, type: 'marketplace', name: 'Wildberries', code: 'wildberries', config: wb || {}, is_active: true },
        { id: 3, type: 'marketplace', name: 'Yandex Market', code: 'yandex', config: ym || {}, is_active: true },
        { id: 4, type: 'supplier', name: 'Mikado', code: 'mikado', config: mikado || {}, is_active: true },
        { id: 5, type: 'supplier', name: 'Moskvorechie', code: 'moskvorechie', config: moskvorechie || {}, is_active: true }
      ];
    }
  }

  /**
   * Получить все настройки интеграций (только конфигурации)
   */
  async getAllConfigs({ profileId = null, onlyActive = false } = {}) {
    if (repositoryFactory.isUsingPostgreSQL()) {
      const integrations = await this.repository.findAll({
        profileId,
        ...(onlyActive ? { isActive: true } : {}),
      });
      const marketplaces = {};
      const suppliers = {};
      
      integrations.forEach(integration => {
        if (integration.type === 'marketplace') {
          marketplaces[integration.code] = integration.config || {};
        } else if (integration.type === 'supplier') {
          suppliers[integration.code] = integration.config || {};
        }
      });
      
      return { marketplaces, suppliers };
    } else {
      // Старое хранилище
      const [ozon, wb, ym, mikado, moskvorechie] = await Promise.all([
        readData('ozon'),
        readData('wildberries'),
        readData('yandex'),
        readData('mikado'),
        readData('moskvorechie')
      ]);
      return {
        marketplaces: { ozon: ozon || {}, wildberries: wb || {}, yandex: ym || {} },
        suppliers: { mikado: mikado || {}, moskvorechie: moskvorechie || {} }
      };
    }
  }

  /**
   * Профили, у которых есть активные интеграции маркетплейсов.
   * Нужны для фоновой синхронизации, чтобы не импортировать заказы в пустые аккаунты.
   */
  async getProfileIdsWithActiveMarketplaceIntegrations() {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      return [];
    }
    const result = await query(
      `SELECT DISTINCT profile_id
       FROM integrations
       WHERE profile_id IS NOT NULL
         AND type = 'marketplace'
         AND is_active = true
       ORDER BY profile_id ASC`
    );
    return (result.rows || [])
      .map((row) => (row?.profile_id != null ? Number(row.profile_id) : null))
      .filter((id) => Number.isFinite(id) && id > 0);
  }

  /**
   * Получить тарифы на логистику Wildberries
   * Сначала проверяет кэш, если данных нет или они устарели - загружает из API
   */
  async getWildberriesTariffs(date = null) {
    try {
      // Сначала проверяем кэш
      const cachedData = await readData('wbTariffsCache');
      if (cachedData && cachedData.data && cachedData.lastUpdate) {
        const lastUpdate = new Date(cachedData.lastUpdate);
        const now = new Date();
        const hoursSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60);
        
        // Если данные обновлены менее 24 часов назад, возвращаем из кэша
        if (hoursSinceUpdate < 24) {
          logger.info('[Integrations Service] Returning WB tariffs from cache');
          return cachedData.data;
        }
      }

      // Если кэша нет или он устарел, загружаем из API
      logger.info('[Integrations Service] Loading WB tariffs from API');
      return await this._fetchWildberriesTariffsFromAPI(date);
    } catch (error) {
      logger.error('[Integrations Service] Error getting WB tariffs:', error);
      // Если ошибка при получении из кэша, пробуем загрузить из API
      try {
        return await this._fetchWildberriesTariffsFromAPI(date);
      } catch (apiError) {
        throw apiError;
      }
    }
  }

  /**
   * Загрузить тарифы из API Wildberries
   * @private
   */
  async _fetchWildberriesTariffsFromAPI(date = null) {
    const config = await this.getMarketplaceConfig('wildberries');
    if (!config || !config.api_key) {
      const err = new Error('API ключ Wildberries не настроен');
      err.statusCode = 400;
      throw err;
    }
    const apiKey = this._normalizeWbToken(config.api_key);
    if (!apiKey) {
      const err = new Error('API ключ Wildberries не настроен');
      err.statusCode = 400;
      throw err;
    }

    const targetDate = date || new Date().toISOString().split('T')[0];
    const url = `https://common-api.wildberries.ru/api/v1/tariffs/box?date=${targetDate}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${apiKey}` }
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      const err = new Error(`Ошибка API Wildberries: ${response.status} - ${errorText}`);
      err.statusCode = response.status;
      throw err;
    }

    const data = await response.json();
    return data;
  }

  /**
   * Ozon: список складов продавца (для сопоставления с фактическим складом).
   * @returns {Promise<object>} сырой ответ API Ozon
   */
  async getOzonWarehouses() {
    const config = await this.getMarketplaceConfig('ozon');
    const clientId = config?.client_id ?? config?.clientId;
    const apiKey = config?.api_key ?? config?.apiKey;
    if (!clientId || !apiKey) {
      const err = new Error('Ozon не настроен (client_id/api_key)');
      err.statusCode = 400;
      throw err;
    }

    // кэш на 6 часов
    const cached = await this._cacheGet({ cache_type: 'ozon', cache_key: 'warehouses' });
    if (cached) return cached;

    // v1/warehouse/list выключен (ошибка: "obsolete method cannot be used"), используем v2.
    const response = await fetch('https://api-seller.ozon.ru/v2/warehouse/list', {
      method: 'POST',
      headers: {
        'Client-Id': String(clientId),
        'Api-Key': String(apiKey),
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      const t = await response.text().catch(() => '');
      const err = new Error(`Ошибка API Ozon warehouses: ${response.status} ${t.substring(0, 300)}`);
      err.statusCode = response.status;
      throw err;
    }
    const data = await response.json();
    await this._cacheSet({ cache_type: 'ozon', cache_key: 'warehouses', cache_value: data, ttl_ms: 6 * 60 * 60 * 1000 });
    return data;
  }

  /**
   * Wildberries: список офисов (складов WB) для FBS, которые требуют пропуск.
   * Это именно те "офисы", которые приходят в заказах FBS в поле offices[].
   */
  async getWildberriesOfficesForPass() {
    const config = await this.getMarketplaceConfig('wildberries');
    const apiKey = this._normalizeWbToken(config?.api_key);
    if (!apiKey) {
      const err = new Error('Wildberries не настроен (api_key)');
      err.statusCode = 400;
      throw err;
    }

    const cached = await this._cacheGet({ cache_type: 'wb', cache_key: 'pass_offices' });
    if (cached) return cached;

    const response = await fetch('https://marketplace-api.wildberries.ru/api/v3/passes/offices', {
      method: 'GET',
      headers: { Authorization: String(apiKey), Accept: 'application/json' },
    });
    if (!response.ok) {
      const t = await response.text().catch(() => '');
      const err = new Error(`Ошибка API WB offices: ${response.status} ${t.substring(0, 300)}`);
      err.statusCode = response.status;
      throw err;
    }
    const data = await response.json();
    await this._cacheSet({ cache_type: 'wb', cache_key: 'pass_offices', cache_value: data, ttl_ms: 6 * 60 * 60 * 1000 });
    return data;
  }

  /**
   * Wildberries: список складов продавца (FBS).
   * Док: GET /api/v3/warehouses (Marketplace API).
   */
  async getWildberriesSellerWarehouses() {
    const config = await this.getMarketplaceConfig('wildberries');
    const apiKey = this._normalizeWbToken(config?.api_key);
    if (!apiKey) {
      const err = new Error('Wildberries не настроен (api_key)');
      err.statusCode = 400;
      throw err;
    }

    const cached = await this._cacheGet({ cache_type: 'wb', cache_key: 'seller_warehouses' });
    if (cached) return cached;

    const response = await fetch('https://marketplace-api.wildberries.ru/api/v3/warehouses', {
      method: 'GET',
      headers: { Authorization: String(apiKey), Accept: 'application/json' },
    });
    if (!response.ok) {
      const t = await response.text().catch(() => '');
      const err = new Error(`Ошибка API WB seller warehouses: ${response.status} ${t.substring(0, 300)}`);
      err.statusCode = response.status;
      throw err;
    }
    const data = await response.json();
    await this._cacheSet({ cache_type: 'wb', cache_key: 'seller_warehouses', cache_value: data, ttl_ms: 6 * 60 * 60 * 1000 });
    return data;
  }

  /**
   * Yandex Market: список кампаний (используем campaignId как "склад" для сопоставления).
   */
  async getYandexCampaigns() {
    const config = await this.getMarketplaceConfig('yandex');
    const apiKey = this._normalizeYandexApiKey(config?.api_key);
    if (!apiKey) {
      const err = new Error('Yandex Market не настроен (api_key)');
      err.statusCode = 400;
      throw err;
    }

    const cached = await this._cacheGet({ cache_type: 'yandex', cache_key: 'campaigns' });
    if (cached) return cached;

    const agent = getYandexHttpsAgent();
    const response = await fetch('https://api.partner.market.yandex.ru/v2/campaigns', {
      method: 'GET',
      // Как в orders.sync.service: заголовок Api-Key
      headers: { 'Api-Key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
      agent,
    });
    if (!response.ok) {
      const t = await response.text().catch(() => '');
      const err = new Error(`Ошибка API Yandex campaigns: ${response.status} ${t.substring(0, 300)}`);
      err.statusCode = response.status;
      throw err;
    }
    const data = await response.json();
    await this._cacheSet({ cache_type: 'yandex', cache_key: 'campaigns', cache_value: data, ttl_ms: 6 * 60 * 60 * 1000 });
    return data;
  }

  /**
   * WB Content API: POST запрос с Authorization.
   * @private
   * @param {string} path
   * @param {object} body
   * @param {{ profileId?: number|string|null }} [opts] — интеграция WB по аккаунту (multi-tenant)
   */
  async _wbContentApiPost(path, body, opts = {}) {
    const profileId = opts.profileId ?? opts.profile_id ?? null;
    const config = await this.getMarketplaceConfig(
      'wildberries',
      profileId != null && profileId !== '' ? { profileId } : {}
    );
    if (!config || !config.api_key) {
      const err = new Error('API ключ Wildberries не настроен');
      err.statusCode = 400;
      throw err;
    }
    const apiKey = this._normalizeWbToken(config.api_key);
    if (!apiKey) {
      const err = new Error('API ключ Wildberries не настроен');
      err.statusCode = 400;
      throw err;
    }
    const url = path.startsWith('http') ? path : `https://content-api.wildberries.ru${path.startsWith('/') ? path : '/' + path}`;
    let response;
    try {
      const fetchWithTimeout = async (init, timeoutMs = 8000) => {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        try {
          return await fetch(url, { ...(init || {}), signal: controller.signal });
        } finally {
          clearTimeout(t);
        }
      };
      response = await fetchWithTimeout({
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      if (e?.name === 'AbortError') {
        throw new Error('Wildberries Content API: таймаут (проверьте сеть/доступ к API).');
      }
      throw new Error('Не удалось связаться с API Wildberries. Проверьте интернет и настройки интеграции.');
    }
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      // Важно: 401 от WB (истёк access token) НЕ должен разлогинивать пользователя в нашем приложении.
      // Поэтому возвращаем прикладную ошибку 400 с понятным сообщением.
      if (response.status === 401) {
        let detail = '';
        let requestId = '';
        let origin = '';
        let title = '';
        try {
          const j = JSON.parse(errorText);
          detail = j?.detail || j?.message || '';
          requestId = j?.requestId || j?.request_id || '';
          origin = j?.origin || '';
          title = j?.title || '';
        } catch (_) {
          detail = errorText || '';
        }
        const diag = [
          title ? `title=${title}` : '',
          origin ? `origin=${origin}` : '',
          requestId ? `requestId=${requestId}` : '',
        ].filter(Boolean).join(', ');
        const msg = (detail && String(detail).toLowerCase().includes('access token expired'))
          ? `Wildberries: API не принимает токен (в ответе: access token expired). ${diag ? `(${diag}) ` : ''}Проверьте, что это токен нужного типа и для нужного кабинета, и вставлен без пробелов. При необходимости перевыпустите токен в ЛК WB → Доступ к API.`
          : `Wildberries: не авторизовано (проверьте токен API в настройках интеграции). ${diag ? `(${diag})` : ''}`.trim();
        const expired = detail && String(detail).toLowerCase().includes('access token expired');
        await addRuntimeNotification({
          type: 'marketplace_api_error',
          severity: 'error',
          source: 'wb.content-api',
          marketplace: 'wildberries',
          title: expired ? 'WB: токен истёк (access token expired)' : 'WB: ошибка авторизации (401)',
          message: expired
            ? `Wildberries вернул "access token expired". Перевыпустите токен в ЛК WB → Доступ к API. ${diag ? `Диагностика: ${diag}` : ''}`.trim()
            : `Wildberries вернул 401 Unauthorized. Проверьте токен API WB в интеграции. ${diag ? `Диагностика: ${diag}` : ''}`.trim()
        });
        const err = new Error(msg);
        err.statusCode = 400;
        throw err;
      }
      const err = new Error(`Ошибка API Wildberries: ${response.status}${errorText ? ' - ' + errorText.substring(0, 300) : ''}`);
      err.statusCode = response.status >= 400 && response.status < 600 ? 502 : 500;
      throw err;
    }
    return response.json();
  }

  /**
   * WB Content API: GET запрос с Authorization.
   * @private
   * @param {string} path
   */
  async _wbContentApiGet(path) {
    const config = await this.getMarketplaceConfig('wildberries');
    if (!config || !config.api_key) {
      const err = new Error('API ключ Wildberries не настроен');
      err.statusCode = 400;
      throw err;
    }
    const apiKey = this._normalizeWbToken(config.api_key);
    if (!apiKey) {
      const err = new Error('API ключ Wildberries не настроен');
      err.statusCode = 400;
      throw err;
    }
    const url = path.startsWith('http') ? path : `https://content-api.wildberries.ru${path.startsWith('/') ? path : '/' + path}`;
    let response;
    try {
      const fetchWithTimeout = async (init, timeoutMs = 8000) => {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        try {
          return await fetch(url, { ...(init || {}), signal: controller.signal });
        } finally {
          clearTimeout(t);
        }
      };
      response = await fetchWithTimeout({
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        }
      });
    } catch (e) {
      if (e?.name === 'AbortError') {
        throw new Error('Wildberries Content API: таймаут (проверьте сеть/доступ к API).');
      }
      throw new Error('Не удалось связаться с API Wildberries. Проверьте интернет и настройки интеграции.');
    }
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      if (response.status === 401) {
        const detail = String(errorText || '');
        const expired = detail.toLowerCase().includes('access token expired');
        await addRuntimeNotification({
          type: 'marketplace_api_error',
          severity: 'error',
          source: 'wb.content-api',
          marketplace: 'wildberries',
          title: expired ? 'WB: токен истёк (access token expired)' : 'WB: ошибка авторизации (401)',
          message: expired
            ? 'Wildberries вернул "access token expired". Перевыпустите токен в ЛК WB → Доступ к API.'
            : 'Wildberries вернул 401 Unauthorized. Проверьте токен API WB в интеграции.'
        });
        const err = new Error('Wildberries: не авторизовано (проверьте токен API в настройках интеграции).');
        err.statusCode = 400;
        throw err;
      }
      const err = new Error(`Ошибка API Wildberries: ${response.status}${errorText ? ' - ' + errorText.substring(0, 300) : ''}`);
      err.statusCode = response.status === 404 ? 404 : (response.status >= 400 && response.status < 600 ? 502 : 500);
      throw err;
    }
    return response.json();
  }

  /**
   * Характеристики категории WB (атрибуты для заполнения карточки).
   * Используем кэш в cache_entries.
   * Endpoint WB: GET /content/v2/object/charcs/{subjectId} (контент API, subjectId в path)
   * @param {string|number} subject_id
   * @param {{ forceRefresh?: boolean }} [opts]
   */
  async getWildberriesCategoryAttributes(subject_id, opts = {}) {
    const subjectIdNum = Number(subject_id) || 0;
    if (subjectIdNum <= 0) {
      const err = new Error('Укажите subject_id (ID категории WB / subjectID).');
      err.statusCode = 400;
      throw err;
    }

    const forceRefresh = this._isTruthy(opts.forceRefresh || opts.force_refresh || opts.force);
    const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней
    const cache_type = 'mp_attributes';
    const cache_key = `wb:${subjectIdNum}`;

    if (!forceRefresh) {
      const cached = await this._cacheGet({ cache_type, cache_key });
      if (Array.isArray(cached)) return cached;
    }

    let data;
    try {
      data = await this._wbContentApiGet(`/content/v2/object/charcs/${subjectIdNum}`);
    } catch (e) {
      if (e?.statusCode === 404) {
        logger.debug('[Integrations Service] WB charcs 404 for subjectId, returning empty list', { subjectId: subjectIdNum });
        const empty = [];
        await this._cacheSet({ cache_type, cache_key, cache_value: empty, ttl_ms: CACHE_TTL_MS }).catch(() => {});
        return empty;
      }
      throw e;
    }
    // Форматы:
    // - { data: [...] }
    // - [...]
    const list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : (Array.isArray(data?.result) ? data.result : []));
    const normalized = Array.isArray(list) ? list : [];

    await this._cacheSet({ cache_type, cache_key, cache_value: normalized, ttl_ms: CACHE_TTL_MS }).catch((e) => {
      logger.warn('[Integrations Service] Failed to cache WB category attributes', { cache_key, err: e?.message });
    });

    return normalized;
  }

  /**
   * Получить карточку товара Wildberries по nmId (номенклатура).
   * WB Content API: POST /content/v2/get/cards/list
   * @param {{ nm_id: number|string, profileId?: number|string|null }} params
   * @returns {Promise<object|null>}
   */
  async getWildberriesProductInfo(params = {}) {
    const nmId = params.nm_id != null ? Number(params.nm_id) : null;
    const profileId = params.profileId ?? params.profile_id ?? null;
    if (!nmId || nmId <= 0) {
      const err = new Error('Укажите nm_id (ID номенклатуры Wildberries).');
      err.statusCode = 400;
      throw err;
    }
    const body = {
      settings: {
        cursor: { limit: 100 },
        filter: { withPhoto: -1, nmID: [nmId] }
      }
    };
    const data = await this._wbContentApiPost('/content/v2/get/cards/list', body, { profileId });
    const cards = data?.cards ?? data?.data?.cards ?? data?.result?.cards ?? [];
    const first = Array.isArray(cards) && cards.length > 0 ? cards[0] : null;
    if (!first) return null;
    // Возвращаем всю карточку (как есть), но добавим нормализованные поля для удобства фронта
    return {
      ...first,
      nmId: first.nmID ?? first.nmId ?? nmId,
      vendorCode: first.vendorCode ?? first.vendor_code ?? null,
      title: first.title ?? first.name ?? first.object ?? null,
      brand: first.brand ?? null,
      description: first.description ?? first.descriptionRu ?? null,
      raw: first
    };
  }

  /**
   * Артикулы продавца (vendorCode) по списку nmId — Content API, один запрос до 100 номенклатур.
   * Нужен для вопросов WB: в ответе «Вопросов» иногда нет supplierArticle, только nmId.
   * @param {(number|string)[]} nmIds
   * @param {number|string|null} profileId
   * @returns {Promise<Map<string, string>>} ключ — nmId строкой, значение — vendorCode
   */
  async getWildberriesVendorCodeMapByNmIds(nmIds, profileId) {
    const map = new Map();
    const unique = [
      ...new Set(
        (nmIds || [])
          .map((x) => (x != null ? String(x).trim() : ''))
          .filter((s) => s !== '' && /^\d+$/.test(s))
      )
    ];
    const nums = unique.map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
    const CHUNK = 100;
    for (let i = 0; i < nums.length; i += CHUNK) {
      const chunk = nums.slice(i, i + CHUNK);
      if (chunk.length === 0) continue;
      const body = {
        settings: {
          cursor: { limit: 100 },
          filter: { withPhoto: -1, nmID: chunk }
        }
      };
      try {
        const data = await this._wbContentApiPost('/content/v2/get/cards/list', body, { profileId });
        const cards = data?.cards ?? data?.data?.cards ?? data?.result?.cards ?? [];
        for (const c of cards || []) {
          const nm = c?.nmID ?? c?.nmId;
          const vc = c?.vendorCode ?? c?.vendor_code ?? null;
          if (nm != null && vc != null && String(vc).trim() !== '') {
            map.set(String(nm), String(vc).trim());
          }
        }
      } catch (e) {
        logger.warn('[Integrations Service] WB vendorCode batch by nmId failed:', e?.message || e);
      }
    }
    return map;
  }

  /**
   * Обновить тарифы Wildberries (вызывается из планировщика)
   */
  async updateWildberriesTariffs() {
    try {
      logger.info('[Integrations Service] Starting WB tariffs update...');
      
      const config = await this.getMarketplaceConfig('wildberries');
      if (!config || !config.api_key) {
        logger.warn('[Integrations Service] WB API key not configured, skipping tariffs update');
        return { success: false, message: 'API ключ не настроен' };
      }

      // Загружаем тарифы из API
      const tariffsData = await this._fetchWildberriesTariffsFromAPI();
      
      // Сохраняем в кэш
      const cacheData = {
        data: tariffsData,
        lastUpdate: new Date().toISOString()
      };
      
      await writeData('wbTariffsCache', cacheData);
      
      logger.info('[Integrations Service] WB tariffs updated successfully');
      return { success: true, message: 'Тарифы обновлены успешно' };
    } catch (error) {
      // При 401 от WB не «роняем» приложение на старте/в планировщике — просто пропускаем обновление.
      const status = error?.statusCode ?? error?.status ?? null;
      const msg = error?.message || '';
      if (status === 401 || String(msg).includes('401') || String(msg).toLowerCase().includes('unauthorized')) {
        logger.warn('[Integrations Service] WB tariffs update skipped (unauthorized). Check WB API token.');
        return { success: false, message: 'WB: нет доступа к API (токен недействителен/отозван). Обновите токен в настройках WB.' };
      }
      logger.error('[Integrations Service] Error updating WB tariffs:', error);
      throw error;
    }
  }

  /**
   * Получить комиссии Wildberries из БД
   * Комиссии обновляются только через планировщик в 01:00
   */
  async getWildberriesCommissions(locale = 'ru') {
    try {
      // Импортируем wbMarketplaceService для получения данных из БД
      const wbMarketplaceService = (await import('./wbMarketplace.service.js')).default;
      
      // Загружаем комиссии из БД
      const commissions = await wbMarketplaceService.getAllCommissions();
      
      // Преобразуем данные из БД в формат, который ожидает фронтенд
      // Формат API: { report: [{ parentID, parentName, subjectID, subjectName, kgvpBooking, kgvpMarketplace, ... }] }
      const report = commissions.map(comm => {
        // Извлекаем данные из raw_data, если они там есть, иначе используем поля из БД
        let rawData = {};
        try {
          if (comm.raw_data) {
            rawData = typeof comm.raw_data === 'string' ? JSON.parse(comm.raw_data) : comm.raw_data;
          }
        } catch (e) {
          logger.warn('[Integrations Service] Failed to parse raw_data for commission:', comm.category_id);
        }
        
        // Логируем первые несколько записей для отладки
        if (commissions.indexOf(comm) < 3) {
          logger.info(`[Integrations Service] Commission ${comm.category_id}:`, {
            hasRawData: !!comm.raw_data,
            rawDataSubjectName: rawData.subjectName,
            category_name: comm.category_name,
            rawDataKeys: Object.keys(rawData)
          });
        }
        
        return {
          parentID: rawData.parentID || null,
          parentName: rawData.parentName || '—',
          subjectID: comm.category_id,
          subjectName: rawData.subjectName || comm.category_name || '—',
          kgvpBooking: rawData.kgvpBooking !== undefined && rawData.kgvpBooking !== null ? rawData.kgvpBooking : null,
          kgvpMarketplace: rawData.kgvpMarketplace !== undefined && rawData.kgvpMarketplace !== null ? rawData.kgvpMarketplace : null,
          kgvpPickup: rawData.kgvpPickup !== undefined && rawData.kgvpPickup !== null ? rawData.kgvpPickup : null,
          kgvpSupplier: rawData.kgvpSupplier !== undefined && rawData.kgvpSupplier !== null ? rawData.kgvpSupplier : null,
          kgvpSupplierExpress: rawData.kgvpSupplierExpress !== undefined && rawData.kgvpSupplierExpress !== null ? rawData.kgvpSupplierExpress : null,
          paidStorageKgvp: rawData.paidStorageKgvp !== undefined && rawData.paidStorageKgvp !== null ? rawData.paidStorageKgvp : null
        };
      });
      
      logger.info(`[Integrations Service] Returning ${report.length} WB commissions from database`);
      return { report };
    } catch (error) {
      logger.error('[Integrations Service] Error getting WB commissions from database:', error);
      throw error;
    }
  }

  /**
   * Получить категории Wildberries из комиссий
   * Возвращает список уникальных категорий (subjectName и subjectID) из комиссий
   */
  async getWildberriesCategories() {
    try {
      // Импортируем wbMarketplaceService для получения данных из БД
      const wbMarketplaceService = (await import('./wbMarketplace.service.js')).default;
      
      // Загружаем комиссии из БД
      const commissions = await wbMarketplaceService.getAllCommissions();
      
      // Если комиссий нет, возвращаем пустой массив
      if (!commissions || commissions.length === 0) {
        logger.info('[Integrations Service] No Wildberries commissions found, returning empty categories list');
        return [];
      }
      
      // Создаем Map для уникальных категорий (по subjectID)
      const categoriesMap = new Map();
      
      commissions.forEach(comm => {
        // Извлекаем данные из raw_data, если они там есть
        let rawData = {};
        try {
          if (comm.raw_data) {
            rawData = typeof comm.raw_data === 'string' ? JSON.parse(comm.raw_data) : comm.raw_data;
          }
        } catch (e) {
          logger.warn('[Integrations Service] Failed to parse raw_data for commission:', comm.category_id);
        }
        
        const subjectID = comm.category_id;
        const subjectName = rawData.subjectName || comm.category_name || '—';
        const parentID = rawData.parentID || null;
        const parentName = rawData.parentName || null;
        
        // Добавляем в Map только если еще нет такой категории
        if (!categoriesMap.has(subjectID)) {
          categoriesMap.set(subjectID, {
            subjectID,
            subjectName,
            parentID,
            parentName
          });
        }
      });
      
      // Преобразуем Map в массив
      const categories = Array.from(categoriesMap.values());
      
      logger.info(`[Integrations Service] Loaded ${categories.length} Wildberries categories from commissions`);
      return categories;
    } catch (error) {
      logger.error('[Integrations Service] Error getting Wildberries categories:', error);
      // Если таблица не существует или другая ошибка БД, возвращаем пустой массив
      if (error.code === '42P01' || error.code === '42P02' || error.message?.includes('does not exist')) {
        logger.warn('[Integrations Service] WB commissions table does not exist, returning empty list');
        return [];
      }
      throw error;
    }
  }
  
  /**
   * Получить категории Ozon
   * По умолчанию: из БД, если свежие (<24 ч). При forceRefresh всегда загружает из API.
   * @param {Object} [opts]
   * @param {boolean} [opts.forceRefresh] — загружать из API Ozon
   * @param {boolean} [opts.dbOnly] — только из БД, никогда не вызывать внешний API (для быстрой загрузки в формах)
   */
  async getOzonCategories(opts = {}) {
    const forceRefresh = !!opts.forceRefresh;
    const dbOnly = !!opts.dbOnly;
    try {
      if (!forceRefresh && this.usePostgreSQL) {
        try {
          const dbCategories = await query(
            `SELECT marketplace_category_id as id, name, path, parent_id, updated_at
             FROM categories 
             WHERE marketplace = 'ozon'
             ORDER BY name`
          );
          
          if (dbCategories.rows && dbCategories.rows.length > 0) {
            const lastUpdate = dbCategories.rows[0]?.updated_at;
            const now = new Date();
            const lastUpdateTime = lastUpdate ? new Date(lastUpdate) : null;
            const hoursSinceUpdate = lastUpdateTime ? (now - lastUpdateTime) / (1000 * 60 * 60) : 999;
            
            if (hoursSinceUpdate < 24 || dbOnly) {
              const mapped = dbCategories.rows.map(cat => {
                const idStr = String(cat.id || '');
                const out = {
                id: cat.id,
                name: cat.name,
                path: cat.path || cat.name,
                disabled: false,
                parent_id: cat.parent_id
                };
                if (idStr.includes('_')) {
                  const [d, t] = idStr.split('_');
                  if (d && t) {
                    out.description_category_id = d.trim() ? Number(d) || d : null;
                    out.type_id = Number(t) || null;
                  }
                }
                return out;
              }).filter(cat => cat.name !== 'Без названия' && (cat.name || '').trim() !== '');
              logger.info(`[Integrations Service] Returning ${mapped.length} Ozon categories from database (updated ${Math.round(hoursSinceUpdate)}h ago)`);
              return mapped;
            } else if (!dbOnly) {
              logger.info(`[Integrations Service] Ozon categories in DB are stale (${Math.round(hoursSinceUpdate)}h old), will refresh from API`);
            }
          }
        } catch (dbError) {
          if (!dbOnly) logger.warn('[Integrations Service] Error loading Ozon categories from DB, will try API:', dbError.message);
        }
      }
      
      if (dbOnly) {
        return [];
      }
      
      const categoriesFromAPI = await this.loadOzonCategoriesFromAPI();
      const filtered = categoriesFromAPI.filter(cat => cat.name !== 'Без названия' && (cat.name || '').trim() !== '');
      if (this.usePostgreSQL && filtered.length > 0) {
        await this.saveOzonCategories(filtered);
      }
      return filtered;
      
    } catch (error) {
      logger.error('[Integrations Service] Error getting Ozon categories:', error);
      
      // Если ошибка при загрузке из API, пробуем вернуть данные из БД (даже если старые)
      if (this.usePostgreSQL) {
        try {
          const dbCategories = await query(
            `SELECT marketplace_category_id as id, name, path, parent_id
             FROM categories 
             WHERE marketplace = 'ozon'
             ORDER BY name
             LIMIT 1000`
          );
          
          if (dbCategories.rows && dbCategories.rows.length > 0) {
            const mapped = dbCategories.rows.map(cat => ({
              id: cat.id,
              name: cat.name,
              path: cat.path || cat.name,
              disabled: false,
              parent_id: cat.parent_id
            })).filter(cat => cat.name !== 'Без названия' && (cat.name || '').trim() !== '');
            logger.info(`[Integrations Service] API failed, returning ${mapped.length} stale categories from DB`);
            return mapped;
          }
        } catch (dbError) {
          logger.warn('[Integrations Service] Failed to get categories from DB as fallback:', dbError.message);
        }
      }
      
      throw error;
    }
  }

  /**
   * Загрузить категории Ozon из API
   * Внутренний метод для загрузки категорий из API Ozon
   */
  async loadOzonCategoriesFromAPI() {
    // Получаем конфигурацию Ozon
    const integrations = await this.getAll();
    const ozonIntegration = integrations.find(i => i.code === 'ozon');
    const client_id = ozonIntegration?.config?.client_id || ozonIntegration?.config?.clientId;
    const api_key = ozonIntegration?.config?.api_key || ozonIntegration?.config?.apiKey;
    
    logger.info('[Integrations Service] Ozon config check:', {
      hasIntegration: !!ozonIntegration,
      hasClientId: !!client_id,
      hasApiKey: !!api_key,
      clientIdLength: client_id?.length || 0,
      apiKeyLength: api_key?.length || 0,
      configKeys: ozonIntegration?.config ? Object.keys(ozonIntegration.config) : []
    });
    
    if (!client_id || !api_key) {
      logger.warn('[Integrations Service] Ozon Client ID or API Key not configured');
      throw new Error('Необходимы Client ID и API Key для подключения к Ozon. Пожалуйста, настройте интеграцию Ozon на странице "Интеграции".');
    }
    
    // Импортируем fetch
    const fetch = (await import('node-fetch')).default;
    
    // Дерево категорий: v1/description-category/tree, language: DEFAULT (см. документацию Ozon)
    const apiUrl = 'https://api-seller.ozon.ru/v1/description-category/tree';
    const requestBody = { language: 'DEFAULT' };
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Client-Id': String(client_id),
        'Api-Key': String(api_key)
      },
      body: JSON.stringify(requestBody),
      timeout: 60000
    });
    logger.info(`[Integrations Service] Ozon categories from: ${apiUrl}, status: ${response.status}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      let errorJson = null;
      try {
        errorJson = JSON.parse(errorText);
      } catch (e) {
        // Не JSON, используем как текст
      }
      
      logger.error('[Integrations Service] Ozon API error:', {
        status: response.status,
        statusText: response.statusText,
        url: apiUrl,
        errorText: errorText.substring(0, 500),
        errorJson: errorJson,
        headers: Object.fromEntries(response.headers.entries())
      });
      
      // Формируем понятное сообщение об ошибке
      let errorMsg = `Ozon API error: ${response.status}`;
      if (response.status === 404) {
        const detail = errorJson?.message || errorText || '';
        errorMsg += ' - Endpoint not found. ';
        if (detail.includes('not found') || detail.includes('404')) {
          errorMsg += 'Возможно, endpoint изменился или требуется другой метод. ';
        }
        errorMsg += 'Проверьте правильность Client ID и API Key. Убедитесь, что используете актуальные учетные данные из личного кабинета Ozon Seller. Также проверьте, что API ключ имеет права на доступ к категориям.';
      } else if (response.status === 401 || response.status === 403) {
        errorMsg += ' - Unauthorized. Проверьте правильность Client ID и API Key. Убедитесь, что ключ активен и не истек срок его действия.';
      } else if (response.status === 429) {
        errorMsg += ' - Too Many Requests. Превышен лимит запросов. Попробуйте позже.';
      } else {
        errorMsg += ` - ${response.statusText || 'Unknown error'}`;
        if (errorJson?.message) {
          errorMsg += `. ${errorJson.message}`;
        } else if (errorText) {
          errorMsg += `. ${errorText.substring(0, 200)}`;
        }
      }
      
      throw new Error(errorMsg);
    }
    
    const data = await response.json();
    
    const flattenCategories = (categories, parentPath = '', parentId = null, parentDescriptionCategoryId = null, indexCounter = { value: 0 }) => {
      const list = Array.isArray(categories) ? categories : [];
      let result = [];
      for (const category of list) {
        const descId = category.description_category_id != null ? Number(category.description_category_id) : null;
        const typeId = category.type_id != null ? Number(category.type_id) : null;
        const isTypeNode = typeId != null && typeId > 0 && parentDescriptionCategoryId != null && parentDescriptionCategoryId > 0;
        let categoryId = descId ?? typeId ?? category.category_id ?? category.id;
        if (!categoryId) {
          categoryId = `temp_${indexCounter.value++}_${Date.now()}`;
          logger.warn('[Integrations Service] Category without ID found, generated temporary ID:', categoryId);
        }
        const rawName = category.category_name || category.type_name || category.name || category.title || category.categoryName || '';
        const displayName = (rawName && String(rawName).trim()) || null;
        const invalidId = !displayName;
        const nextDescId = descId != null ? descId : parentDescriptionCategoryId;
        const children = Array.isArray(category.children) ? category.children : [];
        const sub = Array.isArray(category.subcategories) ? category.subcategories : [];
        const types = Array.isArray(category.types) ? category.types : [];
        const productTypes = Array.isArray(category.product_types) ? category.product_types : [];
        const allChildren = [...children, ...sub, ...types, ...productTypes];
        if (displayName) {
          const categoryPath = parentPath ? `${parentPath} > ${displayName}` : displayName;
          const id = isTypeNode
            ? `${parentDescriptionCategoryId}_${typeId}`
            : String(categoryId);
          result.push({
            id,
            name: displayName,
            path: categoryPath,
            disabled: false,
            parent_id: parentId ? String(parentId) : null,
            description_category_id: isTypeNode ? parentDescriptionCategoryId : (descId != null ? descId : null),
            type_id: isTypeNode ? typeId : (typeId != null ? typeId : null)
          });
          if (allChildren.length > 0) {
            const childCategories = flattenCategories(allChildren, categoryPath, id, nextDescId != null ? nextDescId : parentDescriptionCategoryId, indexCounter);
            result = result.concat(childCategories);
          }
        } else {
          if (allChildren.length > 0) {
            const childCategories = flattenCategories(allChildren, parentPath, parentId, nextDescId != null ? nextDescId : parentDescriptionCategoryId, indexCounter);
            result = result.concat(childCategories);
          }
        }
      }
      return result;
    };
    
    let categoriesTree = data.result ?? data;
    if (!Array.isArray(categoriesTree)) {
      if (categoriesTree && typeof categoriesTree === 'object') {
        categoriesTree = categoriesTree.list ?? categoriesTree.categories ?? categoriesTree.items ?? [];
      }
      categoriesTree = Array.isArray(categoriesTree) ? categoriesTree : [];
    }
    const flatCategories = flattenCategories(categoriesTree);
    
    logger.info(`[Integrations Service] Loaded ${flatCategories.length} Ozon categories from API`);
    
    return flatCategories;
  }

  /**
   * Внутренний запрос к API Ozon Seller (POST).
   * @param {string} path - путь без базового URL, например '/v1/description-category/attribute'
   * @param {object} body - тело запроса
   * @returns {Promise<object>} - ответ result или весь data
   */
  async _ozonApiPost(path, body, { profileId = null, ozonOverride = null } = {}) {
    let client_id;
    let api_key;
    if (ozonOverride && typeof ozonOverride === 'object') {
      client_id = ozonOverride.client_id ?? ozonOverride.clientId;
      api_key = ozonOverride.api_key ?? ozonOverride.apiKey;
    } else if (this.usePostgreSQL && profileId != null && profileId !== '') {
      const ozonCfg = await this.getMarketplaceConfig('ozon', { profileId });
      client_id = ozonCfg?.client_id || ozonCfg?.clientId;
      api_key = ozonCfg?.api_key || ozonCfg?.apiKey;
    } else {
      const integrations = await this.getAll();
      const ozonIntegration = integrations.find(i => i.code === 'ozon');
      client_id = ozonIntegration?.config?.client_id || ozonIntegration?.config?.clientId;
      api_key = ozonIntegration?.config?.api_key || ozonIntegration?.config?.apiKey;
    }
    if (!client_id || !api_key) {
      throw new Error('Необходимы Client ID и API Key для Ozon. Настройте интеграцию на странице "Интеграции".');
    }
    const fetch = (await import('node-fetch')).default;
    const url = path.startsWith('http') ? path : `https://api-seller.ozon.ru${path.startsWith('/') ? path : '/' + path}`;
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Client-Id': String(client_id),
          'Api-Key': String(api_key)
        },
        body: JSON.stringify(body),
        timeout: 30000
      });
    } catch (fetchErr) {
      const code = fetchErr.cause?.code || fetchErr.code || '';
      const msg = code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT'
        ? 'Таймаут соединения с API Ozon. Проверьте интернет или попробуйте позже.'
        : code === 'ENOTFOUND' || code === 'ECONNREFUSED'
          ? 'Не удалось подключиться к API Ozon. Проверьте интернет и доступность api-seller.ozon.ru.'
          : 'Не удалось связаться с API Ozon. Проверьте интернет и настройки интеграции.';
      throw new Error(msg);
    }
    if (!response.ok) {
      const errorText = await response.text();
      let errMsg = `Ozon API ${response.status}`;
      try {
        const j = JSON.parse(errorText);
        if (j.message) errMsg += ': ' + j.message;
      } catch (_) {
        if (errorText) errMsg += ': ' + errorText.substring(0, 200);
      }
      throw new Error(errMsg);
    }
    return response.json();
  }

  /**
   * Получить данные товара из Ozon по product_id или offer_id (артикулу продавца).
   * Использует v3/product/info/list и v4/product/info/attributes для сбора всех возможных данных.
   * @param {{ product_id?: number, offer_id?: string }} params - либо product_id (Ozon), либо offer_id (артикул)
   * @returns {Promise<object|null>} - объект товара из Ozon со всеми полями или null
   */
  async getOzonProductInfo(params = {}) {
    const productId = params.product_id != null ? Number(params.product_id) : null;
    const offerId = params.offer_id != null ? String(params.offer_id).trim() : null;
    if ((!productId || productId <= 0) && (!offerId || offerId === '')) {
      throw new Error('Укажите product_id (Ozon) или offer_id (артикул продавца).');
    }
    const body = productId != null && productId > 0
      ? { product_id: [productId] }
      : { offer_id: [offerId] };
    const data = await this._ozonApiPost('/v3/product/info/list', body);
    const items = data.result?.items ?? data.items ?? [];
    const raw = Array.isArray(items) && items.length > 0 ? items[0] : null;
    if (!raw) return null;

    // Дополнительно запрашиваем атрибуты и расширенные данные через v4
    let v4Data = null;
    const idForFilter = raw.id ?? productId;
    const offerIdForFilter = raw.offer_id ?? raw.offer_id_alt ?? raw.sku ?? offerId;
    try {
      const filter = idForFilter > 0
        ? { product_id: [Number(idForFilter)] }
        : (offerIdForFilter ? { offer_id: [String(offerIdForFilter)] } : null);
      if (filter) {
        const attrsBody = { filter, limit: 100 };
        try {
          v4Data = await this._ozonApiPost('/v4/product/info/attributes', attrsBody);
        } catch (pathErr) {
          if (String(pathErr?.message || '').includes('404')) {
            v4Data = await this._ozonApiPost('/v4/products/info/attributes', attrsBody);
          } else {
            throw pathErr;
          }
        }
      }
    } catch (e) {
      logger.warn('[Integrations Service] Ozon v4 product/info/attributes failed', e?.message);
    }

    const v4Items = v4Data?.result?.items ?? v4Data?.result ?? v4Data?.items ?? [];
    const v4Array = Array.isArray(v4Items) ? v4Items : [];
    const v4Item = v4Array.length > 0
      ? v4Array.find(
          (i) => String(i.id ?? i.product_id) === String(raw.id) ||
            (i.offer_id && String(i.offer_id) === String(raw.offer_id ?? raw.offer_id_alt ?? raw.sku))
        ) ?? v4Array[0]
      : null;

    // Нормализуем name/description только если есть значение (не затираем существующие поля)
    const nameStr = [raw.name, raw.title, raw.product_name].find(Boolean);
    const name = nameStr != null && String(nameStr).trim() ? String(nameStr).trim() : (raw.name ?? raw.title ?? null);
    let descStr = raw.description;
    if (typeof descStr !== 'string' && raw.description_html) descStr = raw.description_html;
    if (typeof descStr !== 'string' && raw.description && typeof raw.description === 'object')
      descStr = raw.description.html ?? raw.description.text ?? '';
    const description = descStr != null && String(descStr).trim() ? String(descStr).trim() : (raw.description ?? raw.description_html ?? null);

    // Объединяем все поля: raw + v4 (атрибуты и прочее) + нормализованные name/description
    const mergedAttributes = (v4Item?.attributes && v4Item.attributes.length > 0)
      ? v4Item.attributes
      : (raw.attributes ?? raw.attribute_values ?? null);
    const item = {
      ...raw,
      ...(v4Item && typeof v4Item === 'object' ? v4Item : {}),
      id: raw.id,
      offer_id: raw.offer_id ?? raw.offer_id_alt ?? raw.sku ?? (v4Item?.offer_id) ?? null,
      name: name ?? v4Item?.name ?? null,
      description: description ?? v4Item?.description ?? null,
      attributes: mergedAttributes
    };
    logger.debug('[Integrations Service] Ozon product info loaded', {
      id: item.id,
      offer_id: item.offer_id,
      hasName: !!item.name,
      hasDescription: !!item.description,
      attributesCount: Array.isArray(item.attributes) ? item.attributes.length : 0,
      fromV4: !!v4Item
    });
    return item;
  }

  /**
   * Получить характеристики категории Ozon для указанных description_category_id и type_id.
   * POST /v1/description-category/attribute
   * API Ozon требует type_id > 0; при type_id=0 подставляем description_category_id.
   */
  async getOzonCategoryAttributes(description_category_id, type_id = 0, opts = {}) {
    const descId = Number(description_category_id) || 0;
    const typeIdNum = Number(type_id) || 0;
    if (descId <= 0 || typeIdNum <= 0) {
      throw new Error('Для запроса атрибутов Ozon нужны description_category_id и type_id > 0. Выберите конкретный тип товара в категории Ozon.');
    }

    const forceRefresh = this._isTruthy(opts.forceRefresh || opts.force_refresh || opts.force);
    // TTL: 14 дней — атрибуты категорий меняются редко, а дергать API часто нельзя
    const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
    const cache_type = 'mp_attributes';
    const cache_key = `ozon:${descId}:${typeIdNum}`;

    if (!forceRefresh) {
      const cached = await this._cacheGet({ cache_type, cache_key });
      if (Array.isArray(cached)) return cached;
    }

    const body = {
      description_category_id: descId,
      language: 'DEFAULT',
      type_id: typeIdNum
    };
    const data = await this._ozonApiPost('/v1/description-category/attribute', body);
    const list = data.result ?? data.attributes ?? data ?? [];
    const normalized = Array.isArray(list) ? list : [];
    // пишем кэш “как есть” (raw list) — нормализацию типов/enum можно добавить позже без ломания контракта
    await this._cacheSet({ cache_type, cache_key, cache_value: normalized, ttl_ms: CACHE_TTL_MS }).catch((e) => {
      logger.warn('[Integrations Service] Failed to cache Ozon category attributes', { cache_key, err: e?.message });
    });
    return normalized;
  }

  /**
   * Получить справочник значений характеристики Ozon.
   * POST /v1/description-category/attribute/values
   */
  async getOzonAttributeValues(attribute_id, description_category_id, type_id, options = {}) {
    const descId = Number(description_category_id) || 0;
    const typeIdNum = Number(type_id) || 0;
    if (descId <= 0 || typeIdNum <= 0) {
      throw new Error('Для запроса значений атрибута Ozon нужны description_category_id и type_id > 0.');
    }

    const forceRefresh = this._isTruthy(options.forceRefresh || options.force_refresh || options.force);
    const attrIdNum = Number(attribute_id);
    const lastValueIdNum = options.last_value_id != null ? Number(options.last_value_id) : 0;
    const limitNum = Math.min(Number(options.limit) || 100, 500);

    // Кэшируем только “первую страницу” справочника (last_value_id=0) — этого хватает для селекта.
    // Если UI захочет пагинацию — будет ходить в API напрямую или добавим расширенный кэш.
    const canCache = lastValueIdNum === 0 && limitNum <= 500;
    const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней: справочники меняются редко
    const cache_type = 'mp_dict_values';
    const cache_key = `ozon:${attrIdNum}:${descId}:${typeIdNum}:limit=${limitNum}`;

    if (canCache && !forceRefresh) {
      const cached = await this._cacheGet({ cache_type, cache_key });
      if (cached && Array.isArray(cached.result)) {
        return { result: cached.result, has_next: Boolean(cached.has_next) };
      }
    }

    const body = {
      attribute_id: attrIdNum,
      description_category_id: descId,
      language: 'DEFAULT',
      last_value_id: lastValueIdNum,
      limit: limitNum,
      type_id: typeIdNum
    };
    const data = await this._ozonApiPost('/v1/description-category/attribute/values', body);
    const result = {
      result: Array.isArray(data.result) ? data.result : [],
      has_next: Boolean(data.has_next)
    };
    if (canCache) {
      await this._cacheSet({ cache_type, cache_key, cache_value: result, ttl_ms: CACHE_TTL_MS }).catch((e) => {
        logger.warn('[Integrations Service] Failed to cache Ozon attribute values', { cache_key, err: e?.message });
      });
    }
    return result;
  }

  /**
   * Догрузить в кэш mp_dict_values значения справочников Ozon (атрибуты с dictionary_id).
   * В карточке товара список подгружается при фокусе на поле; экспорт Excel до этого брал только БД — без вызова списки в файле пустые («Особенности» и др.).
   * @param {Array<{ cache_key: string, cache_value: unknown }>} mpAttributeCaches — cache_type mp_attributes
   * @param {Iterable<string>} existingDictCacheKeys — ключи уже существующих записей mp_dict_values
   * @param {{ maxCalls?: number }} [opts] — лимит запросов к API за один проход (по умолчанию 250)
   */
  async prefetchOzonDictionaryCachesFromMpAttributes(mpAttributeCaches, existingDictCacheKeys, opts = {}) {
    if (!this.cacheRepository || !this.usePostgreSQL) {
      return { fetched: 0, errors: 0, capped: false };
    }
    const maxCalls = Math.min(Math.max(Number(opts.maxCalls) || 250, 1), 500);
    const attempted = new Set([...(existingDictCacheKeys || [])].map((k) => String(k)));
    let fetched = 0;
    let errors = 0;
    const LIMIT = 500;

    for (const entry of mpAttributeCaches || []) {
      if (fetched >= maxCalls) break;
      const ck = String(entry.cache_key || '');
      const m = /^ozon:(\d+):(\d+)$/.exec(ck);
      if (!m) continue;
      const descId = Number(m[1]);
      const typeId = Number(m[2]);
      if (descId <= 0 || typeId <= 0) continue;

      const raw = this._safeParseJsonMaybe(entry.cache_value);
      if (raw == null) continue;
      let arr = Array.isArray(raw) ? raw : [];
      if (!arr.length && typeof raw === 'object' && Array.isArray(raw.result)) arr = raw.result;
      if (!arr.length && typeof raw === 'object' && Array.isArray(raw.attributes)) arr = raw.attributes;
      if (!Array.isArray(arr) || !arr.length) continue;

      for (const a of arr) {
        if (fetched >= maxCalls) break;
        const attrId = a?.id ?? a?.attribute_id;
        if (attrId == null || String(attrId).trim() === '') continue;
        const dictNum = this._ozonEffectiveDictionaryId(a);
        if (!dictNum) continue;

        const cacheKey = `ozon:${Number(attrId)}:${descId}:${typeId}:limit=${LIMIT}`;
        if (attempted.has(cacheKey)) continue;
        attempted.add(cacheKey);

        try {
          await this.getOzonAttributeValues(attrId, descId, typeId, { limit: LIMIT });
          fetched += 1;
        } catch (e) {
          errors += 1;
          logger.warn('[Integrations Service] Prefetch Ozon dict values for Excel failed', {
            cacheKey,
            err: e?.message
          });
        }
      }
    }

    return { fetched, errors, capped: fetched >= maxCalls };
  }

  /**
   * Поиск справочных значений характеристики Ozon по value.
   * POST /v1/description-category/attribute/values/search
   */
  async searchOzonAttributeValues(attribute_id, description_category_id, type_id, value) {
    const descId = Number(description_category_id) || 0;
    const typeIdNum = Number(type_id) || 0;
    if (descId <= 0 || typeIdNum <= 0) {
      throw new Error('Для поиска значений атрибута Ozon нужны description_category_id и type_id > 0.');
    }
    const body = {
      attribute_id: Number(attribute_id),
      description_category_id: descId,
      limit: 100,
      type_id: typeIdNum,
      value: String(value || '').trim() || ''
    };
    const data = await this._ozonApiPost('/v1/description-category/attribute/values/search', body);
    const list = data.result ?? data ?? [];
    return Array.isArray(list) ? list : [];
  }

  /**
   * Сохранить категории Ozon в БД
   */
  async saveOzonCategories(categories) {
    if (!this.usePostgreSQL) {
      logger.warn('[Integrations Service] PostgreSQL not enabled, skipping Ozon categories save');
      return { saved: 0, updated: 0, total: 0 };
    }

    return await transaction(async (client) => {
      let saved = 0;
      let updated = 0;
      
      // Сначала создаем маппинг marketplace_category_id -> db_id для родительских категорий
      const categoryIdMap = new Map();
      
      // Проходим по категориям дважды: сначала создаем/обновляем все категории,
      // затем обновляем parent_id на основе маппинга
      for (const cat of categories) {
        const categoryId = String(cat.id);
        
        // Проверяем, существует ли категория
        const existing = await client.query(
          `SELECT id FROM categories 
           WHERE marketplace = 'ozon' AND marketplace_category_id = $1`,
          [categoryId]
        );
        
        let dbId;
        if (existing.rows.length > 0) {
          dbId = existing.rows[0].id;
          // Обновляем существующую категорию (без parent_id пока)
          await client.query(
            `UPDATE categories 
             SET name = $1, path = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [cat.name, cat.path || cat.name, dbId]
          );
          updated++;
        } else {
          // Создаем новую категорию (без parent_id пока)
          const result = await client.query(
            `INSERT INTO categories (marketplace, marketplace_category_id, name, path)
             VALUES ('ozon', $1, $2, $3)
             RETURNING id`,
            [categoryId, cat.name, cat.path || cat.name]
          );
          dbId = result.rows[0].id;
          saved++;
        }
        
        categoryIdMap.set(categoryId, { dbId, parentId: cat.parent_id });
      }
      
      // Теперь обновляем parent_id для всех категорий
      for (const cat of categories) {
        const categoryId = String(cat.id);
        const categoryData = categoryIdMap.get(categoryId);
        
        if (categoryData && cat.parent_id) {
          // Находим parent_marketplace_id по parent_id из API
          const parentCategory = categories.find(c => c.id === cat.parent_id);
          if (parentCategory) {
            const parentCategoryId = String(parentCategory.id);
            const parentData = categoryIdMap.get(parentCategoryId);
            
            if (parentData) {
              await client.query(
                `UPDATE categories SET parent_id = $1 WHERE id = $2`,
                [parentData.dbId, categoryData.dbId]
              );
            }
          }
        }
      }
      
      logger.info(`[Integrations Service] Ozon categories saved: ${saved} new, ${updated} updated`);
      return { saved, updated, total: categories.length };
    });
  }

  /**
   * Получить категории Яндекс.Маркета
   * Из БД, если свежие (<24 ч), иначе загружает из API.
   * @param {boolean} [opts.dbOnly] — только из БД, никогда не вызывать внешний API
   */
  async getYandexCategories(opts = {}) {
    const forceRefresh = !!opts.forceRefresh;
    const dbOnly = !!opts.dbOnly;
    try {
      if (!forceRefresh && this.usePostgreSQL) {
        try {
          const dbCategories = await query(
            `SELECT marketplace_category_id as id, name, path, parent_id, updated_at
             FROM categories 
             WHERE marketplace = 'ym'
             ORDER BY name`
          );

          if (dbCategories.rows && dbCategories.rows.length > 0) {
            const lastUpdate = dbCategories.rows[0]?.updated_at;
            const now = new Date();
            const lastUpdateTime = lastUpdate ? new Date(lastUpdate) : null;
            const hoursSinceUpdate = lastUpdateTime ? (now - lastUpdateTime) / (1000 * 60 * 60) : 999;

            if (hoursSinceUpdate < 24 || dbOnly) {
              const mapped = dbCategories.rows.map(cat => ({
                id: String(cat.id),
                name: cat.name,
                path: cat.path || cat.name,
                marketplace_category_id: cat.id,
                marketplace: 'ym',
                parent_id: cat.parent_id ? String(cat.parent_id) : null
              })).filter(cat => cat.name && String(cat.name).trim() !== '');
              logger.info(`[Integrations Service] Returning ${mapped.length} Yandex categories from database (updated ${Math.round(hoursSinceUpdate)}h ago)`);
              return mapped;
            } else if (!dbOnly) {
              logger.info(`[Integrations Service] Yandex categories in DB are stale (${Math.round(hoursSinceUpdate)}h old), will refresh from API`);
            }
          }
        } catch (dbError) {
          if (!dbOnly) logger.warn('[Integrations Service] Error loading Yandex categories from DB, will try API:', dbError.message);
        }
      }

      if (dbOnly) return [];

      const categoriesFromAPI = await this.loadYandexCategoriesFromAPI();
      const filtered = categoriesFromAPI.filter(cat => cat.name && String(cat.name).trim() !== '');
      if (this.usePostgreSQL && filtered.length > 0) {
        await this.saveYandexCategories(filtered);
      }
      return filtered;
    } catch (error) {
      logger.error('[Integrations Service] Error getting Yandex categories:', error);

      if (this.usePostgreSQL) {
        try {
          const dbCategories = await query(
            `SELECT marketplace_category_id as id, name, path, parent_id
             FROM categories 
             WHERE marketplace = 'ym'
             ORDER BY name
             LIMIT 1000`
          );

          if (dbCategories.rows && dbCategories.rows.length > 0) {
            const mapped = dbCategories.rows.map(cat => ({
              id: String(cat.id),
              name: cat.name,
              path: cat.path || cat.name,
              marketplace_category_id: cat.id,
              marketplace: 'ym',
              parent_id: cat.parent_id ? String(cat.parent_id) : null
            })).filter(cat => cat.name && String(cat.name).trim() !== '');
            logger.info(`[Integrations Service] API failed, returning ${mapped.length} stale Yandex categories from DB`);
            return mapped;
          }
        } catch (dbError) {
          logger.warn('[Integrations Service] Failed to get Yandex categories from DB as fallback:', dbError.message);
        }
      }

      throw error;
    }
  }

  /**
   * Нормализация Api-Key Яндекс.Маркета: убрать пробелы, BOM, переносы строк.
   */
  _normalizeYandexApiKey(apiKey) {
    if (apiKey == null) return '';
    return String(apiKey).replace(/\s+/g, ' ').replace(/\uFEFF/g, '').trim();
  }

  /**
   * Дополнительные числовые поля из ответа GET /api/v1/account/balance (WB может отдавать «в обработке» и др.).
   * @private
   */
  _wbParseExtraBalanceAmounts(body) {
    if (!body || typeof body !== 'object') return [];
    const skip = new Set(['currency', 'current', 'for_withdraw']);
    const out = [];
    for (const [k, v] of Object.entries(body)) {
      if (skip.has(k)) continue;
      let n;
      if (typeof v === 'number' && Number.isFinite(v)) n = v;
      else if (typeof v === 'string' && String(v).trim() !== '') {
        n = Number(String(v).replace(',', '.').trim());
      } else continue;
      if (!Number.isFinite(n)) continue;
      const kl = String(k).toLowerCase().replace(/-/g, '_');
      let label;
      if (kl.includes('process') || kl.includes('pending') || kl.includes('queue')) {
        label = 'Платежи в обработке / ожидание';
      } else if (kl.includes('frozen') || kl.includes('block') || kl.includes('hold')) {
        label = 'Зарезервировано / заморозка';
      } else if (kl.includes('mutual') || kl.includes('settlement') || kl.includes('accrual')) {
        label = 'Взаиморасчёты / начисления';
      } else if (kl.includes('pay') || kl.includes('withdraw') || kl.includes('payout')) {
        label = 'Выплаты';
      } else {
        label = `Поле «${k}»`;
      }
      out.push({ key: k, label, amountRub: n });
    }
    out.sort((a, b) => String(a.key).localeCompare(String(b.key), 'en'));
    return out;
  }

  /**
   * Справка по магазину Яндекс.Маркета (GET /v2/campaigns/{id}) — суммы «кошелька» API не отдаёт.
   * @private
   */
  async _fetchYandexCampaignSnapshot(campaignId, apiKey) {
    const cid = Number(campaignId);
    if (!Number.isFinite(cid) || cid <= 0) {
      const err = new Error('Укажите campaign_id (магазин) в интеграции Яндекс.Маркета');
      err.statusCode = 400;
      throw err;
    }
    const key = this._normalizeYandexApiKey(apiKey);
    if (!key) {
      const err = new Error('Api-Key Яндекс.Маркета не настроен');
      err.statusCode = 400;
      throw err;
    }
    const fetch = (await import('node-fetch')).default;
    const agent = getYandexHttpsAgent();
    const url = `https://api.partner.market.yandex.ru/v2/campaigns/${encodeURIComponent(String(cid))}`;
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Api-Key': key },
        ...(agent ? { agent } : {})
      });
    } catch (e) {
      throw new Error(`Яндекс.Маркет: не удалось запросить магазин. ${formatYandexNetworkError(e)}`);
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      let msg = `Яндекс.Маркет API ${response.status}`;
      try {
        const j = JSON.parse(text);
        const errs = j?.errors || j?.error?.errors;
        if (Array.isArray(errs) && errs[0]?.message) msg += `: ${errs[0].message}`;
        else if (j?.message) msg += `: ${j.message}`;
      } catch (_) {
        if (text) msg += `: ${text.substring(0, 200)}`;
      }
      if (response.status === 403) {
        msg +=
          ' Возможно, у токена нет доступа к магазину или нужен доступ «Просмотр финансовой информации» для отчётов в ЛК.';
      }
      const err = new Error(msg);
      err.statusCode = response.status;
      throw err;
    }
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      data = {};
    }
    const camp = data?.result?.campaign ?? data?.campaign ?? null;
    if (!camp || typeof camp !== 'object') {
      return { campaignId: cid, domain: null, placementType: null, businessId: null, businessName: null, clientId: null };
    }
    return {
      campaignId: cid,
      domain: camp.domain != null ? String(camp.domain) : null,
      placementType: camp.placementType != null ? String(camp.placementType) : null,
      businessId: camp.business?.id != null ? Number(camp.business.id) : null,
      businessName: camp.business?.name != null ? String(camp.business.name) : null,
      clientId: camp.clientId != null ? Number(camp.clientId) : null
    };
  }

  /**
   * Проверка токена Яндекс.Маркета через POST /v2/auth/token.
   * Возвращает { valid, message, scopes? }. Метод доступен только для Api-Key (не OAuth).
   */
  async _validateYandexToken(apiKey) {
    const key = this._normalizeYandexApiKey(apiKey);
    if (!key) {
      return { valid: false, message: 'Укажите API Key в настройках интеграции (Настройки → API и модули → Токены авторизации в кабинете Маркета).' };
    }
    const fetch = (await import('node-fetch')).default;
    const agent = getYandexHttpsAgent();
    const fetchOpts = agent ? { agent } : {};
    const url = 'https://api.partner.market.yandex.ru/v2/auth/token';

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Api-Key': key
        },
        body: JSON.stringify({}),
        ...fetchOpts
      });
    } catch (netErr) {
      // Запасная проверка тем же хостом, что и синхронизация заказов (GET /v2/campaigns)
      try {
        const campaignsUrl = 'https://api.partner.market.yandex.ru/v2/campaigns';
        const res2 = await fetch(campaignsUrl, {
          method: 'GET',
          headers: {
            'Api-Key': key,
            'Content-Type': 'application/json'
          },
          ...fetchOpts
        });
        if (res2.ok) {
          return {
            valid: true,
            message:
              'Яндекс.Маркет: API Key принят (проверка через GET /v2/campaigns). POST /v2/auth/token с этого сервера недоступен — часто из‑за прокси/firewall; убедитесь, что для Node задан HTTPS_PROXY.',
            scopes: []
          };
        }
        const t = await res2.text().catch(() => '');
        if (res2.status === 401 || res2.status === 403) {
          const hint = key.startsWith('ACMA:')
            ? ' Нужен Api-Key из кабинета (Настройки → API и модули → Токены авторизации).'
            : ' Проверьте, что вставлен Api-Key формата ACMA:...';
          return {
            valid: false,
            message: `Яндекс.Маркет: ключ не принят (${res2.status}).${hint}${t ? ` ${t.substring(0, 180)}` : ''}`
          };
        }
      } catch (_) {
        /* оба запроса недоступны */
      }
      return {
        valid: false,
        message: `Яндекс.Маркет: сеть — ${formatYandexNetworkError(netErr, url)}`
      };
    }

    const bodyText = await response.text();
    let body = {};
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch (_) {}

    if (response.ok) {
      const scopes = body?.result?.apiKey?.authScopes ?? body?.apiKey?.authScopes ?? [];
      const name = body?.result?.apiKey?.name ?? body?.apiKey?.name ?? '';
      const scopeStr = Array.isArray(scopes) && scopes.length ? scopes.join(', ') : '';
      const msg = scopeStr
        ? `Яндекс.Маркет: токен валиден${name ? ` (${name})` : ''}. Доступы: ${scopeStr}`
        : 'Яндекс.Маркет: токен валиден';
      return { valid: true, message: msg, scopes: Array.isArray(scopes) ? scopes : [] };
    }

    const errMsg = body?.errors?.[0]?.message ?? body?.message ?? bodyText?.substring(0, 150) ?? '';
    if (response.status === 401) {
      const hint = key.startsWith('ACMA:')
        ? ' Токен должен быть Api-Key из кабинета (Настройки → API и модули → Токены авторизации), не OAuth.'
        : ' Убедитесь, что скопировали именно Api-Key (формат ACMA:...), не пароль и не OAuth-токен.';
      return {
        valid: false,
        message: `Яндекс.Маркет: токен не принят (401).${hint}${errMsg ? ` Ответ API: ${errMsg}` : ''}`
      };
    }
    if (response.status === 403) {
      return {
        valid: false,
        message: `Яндекс.Маркет: доступ запрещён (403).${errMsg ? ` ${errMsg}` : ''}`
      };
    }
    return {
      valid: false,
      message: `Яндекс.Маркет: ошибка ${response.status}.${errMsg ? ` ${errMsg}` : ''}`
    };
  }

  /**
   * Загрузить категории Яндекс.Маркета из API
   * Endpoint: https://api.partner.market.yandex.ru/v2/categories/tree
   */
  async loadYandexCategoriesFromAPI() {
    const integrations = await this.getAll();
    const yandexIntegration = integrations.find(i => i.code === 'yandex');
    const api_key = this._normalizeYandexApiKey(yandexIntegration?.config?.api_key);

    if (!api_key) {
      throw new Error('Необходим API Key для подключения к Яндекс.Маркету. Настройте интеграцию на странице "Интеграции".');
    }

    const fetch = (await import('node-fetch')).default;
    const apiUrl = 'https://api.partner.market.yandex.ru/v2/categories/tree';
    const agent = getYandexHttpsAgent();
    const fetchBase = agent ? { agent } : {};

    // API Яндекс.Маркета: только заголовок Api-Key (документация — не использовать Authorization: Bearer)
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Api-Key': api_key
    };

    let response = await fetch(apiUrl, {
      method: 'GET',
      headers,
      ...fetchBase
    });

    if (response.status === 405 || response.status === 404) {
      response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
        ...fetchBase
      });
    }

    logger.info(`[Integrations Service] Yandex categories from: ${apiUrl}, status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = `Ошибка API Яндекс.Маркета: ${response.status}`;
      if (response.status === 401 || response.status === 403) {
        errorMsg += '. Проверьте API Key в настройках интеграции. Для Api-Key укажите токен из кабинета: Настройки → API и модули → Токены авторизации; убедитесь, что у токена есть доступ к методам категорий.';
      } else if (errorText) {
        errorMsg += ` - ${errorText.substring(0, 200)}`;
      }
      throw new Error(errorMsg);
    }

    const data = await response.json();

    const flattenCategories = (categories, parentPath = '', parentId = null) => {
      const arr = Array.isArray(categories) ? categories : [];

      let result = [];
      for (const category of arr) {
        const categoryId = category.id ?? category.categoryId ?? category.typeId;
        const rawName = category.name ?? category.categoryName ?? category.title ?? '';
        const displayName = rawName && String(rawName).trim() ? rawName.trim() : null;
        const children = category.children ?? category.subcategories ?? category.childCategories ?? [];

        if (displayName && categoryId) {
          const categoryPath = parentPath ? `${parentPath} > ${displayName}` : displayName;
          result.push({
            id: String(categoryId),
            name: displayName,
            path: categoryPath,
            parent_id: parentId ? String(parentId) : null
          });
          if (children.length > 0) {
            const childCategories = flattenCategories(children, categoryPath, categoryId);
            result = result.concat(childCategories);
          }
        } else if (children.length > 0) {
          const childCategories = flattenCategories(children, parentPath, parentId);
          result = result.concat(childCategories);
        }
      }
      return result;
    };

    let tree = data.result?.result ?? data.result?.categories ?? data.categories ?? data.result ?? data;
    if (!Array.isArray(tree)) {
      tree = tree && typeof tree === 'object' ? (tree.categories ?? tree.children ?? []) : [];
    }
    tree = Array.isArray(tree) ? tree : [];

    const flatCategories = flattenCategories(tree);

    logger.info(`[Integrations Service] Loaded ${flatCategories.length} Yandex categories from API`);
    return flatCategories;
  }

  /**
   * Нормализация одной характеристики категории YM для UI (ProductForm).
   * @private
   */
  _normalizeYandexCategoryParameter(p) {
    if (!p || p.id == null) return null;
    const id = Number(p.id);
    if (!Number.isFinite(id)) return null;
    const name = (p.name && String(p.name).trim()) ? String(p.name).trim() : `Параметр ${id}`;
    const ymType = String(p.type || 'TEXT').toUpperCase();
    const values = Array.isArray(p.values) ? p.values : [];
    let type = 'string';
    let dictionary_options = null;
    if (ymType === 'ENUM' && values.length > 0) {
      type = 'dictionary';
      dictionary_options = values
        .filter((v) => v && v.id != null)
        .map((v) => ({
          id: v.id,
          label: String(v.value ?? v.description ?? v.id)
        }));
    } else if (ymType === 'BOOLEAN') {
      type = 'boolean';
    } else if (ymType === 'NUMERIC') {
      type = 'number';
    }
    return {
      id,
      name,
      description: p.description ? String(p.description) : '',
      required: Boolean(p.required),
      multivalue: Boolean(p.multivalue),
      ym_parameter_type: ymType,
      type,
      dictionary_options,
      constraints: p.constraints && typeof p.constraints === 'object' ? p.constraints : null,
      allow_custom: Boolean(p.allowCustomValues)
    };
  }

  /**
   * Характеристики листовой категории Яндекс.Маркета (для заполнения карточки).
   * POST https://api.partner.market.yandex.ru/v2/category/{categoryId}/parameters
   * Опционально ?businessId= — из интеграции (business_id / campaign_id).
   *
   * @param {number|string} categoryId
   * @param {{ forceRefresh?: boolean }} [opts]
   * @returns {Promise<object[]>}
   */
  async getYandexCategoryContentParameters(categoryId, opts = {}) {
    const catIdStr = categoryId != null ? String(categoryId).trim().replace(/\s+/g, '') : '';
    if (!catIdStr || !/^\d+$/.test(catIdStr)) {
      throw new Error('Некорректный id категории Яндекс.Маркета (ожидается числовой id листовой категории из дерева Маркета).');
    }

    const integrations = await this.getAll();
    const yandexIntegration = integrations.find((i) => i.code === 'yandex');
    const api_key = this._normalizeYandexApiKey(yandexIntegration?.config?.api_key);
    if (!api_key) {
      throw new Error('Необходим API Key Яндекс.Маркета. Настройте интеграцию на странице «Интеграции».');
    }

    const cfg = yandexIntegration?.config || {};
    const businessIdRaw = cfg.business_id ?? cfg.businessId ?? cfg.campaign_id ?? cfg.campaignId;
    let businessId = null;
    if (businessIdRaw != null && String(businessIdRaw).trim() !== '') {
      const n = Number(businessIdRaw);
      if (Number.isFinite(n) && n > 0) businessId = n;
    }

    const forceRefresh = this._isTruthy(opts.forceRefresh || opts.force_refresh || opts.force);
    const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
    const cache_type = 'mp_attributes';
    const cache_key = `ym:${catIdStr}:${businessId || 0}`;

    if (!forceRefresh) {
      const cached = await this._cacheGet({ cache_type, cache_key });
      if (Array.isArray(cached)) return cached;
    }

    const fetch = (await import('node-fetch')).default;
    let url = `https://api.partner.market.yandex.ru/v2/category/${catIdStr}/parameters`;
    if (businessId != null) {
      url += `?businessId=${businessId}`;
    }

    const agent = getYandexHttpsAgent();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Api-Key': api_key
      },
      body: JSON.stringify({}),
      ...(agent && { agent })
    });

    const errorText = await response.text();
    let data = {};
    try {
      data = errorText ? JSON.parse(errorText) : {};
    } catch (_) {
      data = {};
    }

    if (!response.ok) {
      const errMsg = data?.errors?.[0]?.message ?? data?.message ?? errorText?.substring(0, 300) ?? '';
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Яндекс.Маркет: нет доступа к характеристикам категории (${response.status}). Проверьте API Key и права offers-and-cards-management. ${errMsg}`.trim());
      }
      throw new Error(`Яндекс.Маркет: ошибка ${response.status} при запросе параметров категории. ${errMsg}`.trim());
    }

    if (data.status && String(data.status).toUpperCase() === 'ERROR') {
      const errMsg = data?.errors?.[0]?.message ?? 'Неизвестная ошибка API';
      throw new Error(`Яндекс.Маркет: ${errMsg}`);
    }

    const result = data.result ?? data;
    const rawParams = Array.isArray(result?.parameters) ? result.parameters : [];
    const normalized = rawParams
      .map((p) => this._normalizeYandexCategoryParameter(p))
      .filter(Boolean);

    await this._cacheSet({ cache_type, cache_key, cache_value: normalized, ttl_ms: CACHE_TTL_MS }).catch((e) => {
      logger.warn('[Integrations Service] Failed to cache Yandex category parameters', { cache_key, err: e?.message });
    });

    logger.info(`[Integrations Service] Yandex category ${catIdStr} parameters: ${normalized.length} fields`);
    return normalized;
  }

  /**
   * Сохранить категории Яндекс.Маркета в БД
   */
  async saveYandexCategories(categories) {
    if (!this.usePostgreSQL) {
      logger.warn('[Integrations Service] PostgreSQL not enabled, skipping Yandex categories save');
      return { saved: 0, updated: 0, total: 0 };
    }

    return await transaction(async (client) => {
      let saved = 0;
      let updated = 0;
      const categoryIdMap = new Map();

      for (const cat of categories) {
        const categoryId = String(cat.id);

        const existing = await client.query(
          `SELECT id FROM categories 
           WHERE marketplace = 'ym' AND marketplace_category_id = $1`,
          [categoryId]
        );

        let dbId;
        if (existing.rows.length > 0) {
          dbId = existing.rows[0].id;
          await client.query(
            `UPDATE categories 
             SET name = $1, path = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [cat.name, cat.path || cat.name, dbId]
          );
          updated++;
        } else {
          const result = await client.query(
            `INSERT INTO categories (marketplace, marketplace_category_id, name, path)
             VALUES ('ym', $1, $2, $3)
             RETURNING id`,
            [categoryId, cat.name, cat.path || cat.name]
          );
          dbId = result.rows[0].id;
          saved++;
        }

        categoryIdMap.set(categoryId, { dbId, parentId: cat.parent_id });
      }

      for (const cat of categories) {
        const categoryId = String(cat.id);
        const categoryData = categoryIdMap.get(categoryId);

        if (categoryData && cat.parent_id) {
          const parentCategory = categories.find(c => c.id === cat.parent_id);
          if (parentCategory) {
            const parentCategoryId = String(parentCategory.id);
            const parentData = categoryIdMap.get(parentCategoryId);

            if (parentData) {
              await client.query(
                `UPDATE categories SET parent_id = $1 WHERE id = $2`,
                [parentData.dbId, categoryData.dbId]
              );
            }
          }
        }
      }

      logger.info(`[Integrations Service] Yandex categories saved: ${saved} new, ${updated} updated`);
      return { saved, updated, total: categories.length };
    });
  }

  /**
   * Обновить категории Яндекс.Маркета вручную
   */
  async updateYandexCategories() {
    try {
      logger.info('[Integrations Service] Starting manual update of Yandex categories...');

      const categories = await this.loadYandexCategoriesFromAPI();

      if (this.usePostgreSQL && categories.length > 0) {
        const saveResult = await this.saveYandexCategories(categories);
        logger.info('[Integrations Service] Yandex categories update completed:', saveResult);
        return { success: true, categories: saveResult };
      }

      return { success: true, categories: { total: categories.length } };
    } catch (error) {
      logger.error('[Integrations Service] Error updating Yandex categories:', error);
      throw error;
    }
  }

  /**
   * Обновить категории Ozon вручную
   * Принудительно загружает категории из API и сохраняет в БД
   */
  async updateOzonCategories() {
    try {
      logger.info('[Integrations Service] Starting manual update of Ozon categories...');
      
      // Загружаем из API
      const categories = await this.loadOzonCategoriesFromAPI();
      
      // Сохраняем в БД
      if (this.usePostgreSQL && categories.length > 0) {
        const saveResult = await this.saveOzonCategories(categories);
        logger.info('[Integrations Service] Ozon categories update completed:', saveResult);
        return {
          success: true,
          categories: saveResult
        };
      }
      
      return {
        success: true,
        categories: { total: categories.length }
      };
      
    } catch (error) {
      logger.error('[Integrations Service] Error updating Ozon categories:', error);
      throw error;
    }
  }

  /**
   * Загрузить комиссии из API Wildberries
   * @private
   */
  async _fetchWildberriesCommissionsFromAPI(locale = 'ru') {
    const config = await this.getMarketplaceConfig('wildberries');
    if (!config || !config.api_key) {
      const err = new Error('API ключ Wildberries не настроен');
      err.statusCode = 400;
      throw err;
    }
    const apiKey = this._normalizeWbToken(config.api_key);
    if (!apiKey) {
      const err = new Error('API ключ Wildberries не настроен');
      err.statusCode = 400;
      throw err;
    }

    const url = `https://common-api.wildberries.ru/api/v1/tariffs/commission?locale=${locale}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${apiKey}` }
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      const err = new Error(`Ошибка API Wildberries: ${response.status} - ${errorText}`);
      err.statusCode = response.status;
      throw err;
    }

    const data = await response.json();
    return data;
  }

  /**
   * Обновить комиссии Wildberries (вызывается из планировщика)
   * Загружает комиссии из API и сохраняет в БД
   */
  async updateWildberriesCommissions() {
    try {
      logger.info('[Integrations Service] Starting WB commissions update...');
      
      const config = await this.getMarketplaceConfig('wildberries');
      if (!config || !config.api_key) {
        logger.warn('[Integrations Service] WB API key not configured, skipping commissions update');
        return { success: false, message: 'API ключ не настроен' };
      }

      // Импортируем wbMarketplaceService для сохранения в БД
      const wbMarketplaceService = (await import('./wbMarketplace.service.js')).default;

      // Загружаем комиссии из API (используем русскую локаль)
      const commissionsData = await this._fetchWildberriesCommissionsFromAPI('ru');
      
      // Преобразуем данные в формат для сохранения в БД
      // API возвращает { report: [...] }, где каждый элемент имеет структуру:
      // { parentID, parentName, subjectID, subjectName, kgvpBooking, kgvpMarketplace, kgvpPickup, kgvpSupplier, kgvpSupplierExpress, paidStorageKgvp }
      let commissions = [];
      if (commissionsData.report && Array.isArray(commissionsData.report)) {
        commissions = commissionsData.report;
      } else if (commissionsData.data && Array.isArray(commissionsData.data)) {
        commissions = commissionsData.data;
      } else if (Array.isArray(commissionsData)) {
        commissions = commissionsData;
      }
      
      if (commissions.length === 0) {
        logger.warn('[Integrations Service] No commissions data found in API response');
        return { success: false, message: 'Нет данных о комиссиях в ответе API' };
      }
      
      // Сохраняем в БД через wbMarketplaceService
      // wbMarketplaceService.saveCommissions() ожидает массив объектов с полями:
      // subjectID, name (или categoryName), kgvpMarketplace, kgvpSupplier и т.д.
      const saveResult = await wbMarketplaceService.saveCommissions(commissions);
      
      logger.info('[Integrations Service] WB commissions updated successfully', saveResult);
      return { 
        success: true, 
        message: 'Комиссии обновлены успешно',
        data: saveResult
      };
    } catch (error) {
      const status = error?.statusCode ?? error?.status ?? null;
      const msg = error?.message || '';
      if (status === 401 || String(msg).includes('401') || String(msg).toLowerCase().includes('unauthorized')) {
        logger.warn('[Integrations Service] WB commissions update skipped (unauthorized). Check WB API token.');
        return { success: false, message: 'WB: нет доступа к API (токен недействителен/отозван). Обновите токен в настройках WB.' };
      }
      logger.error('[Integrations Service] Error updating WB commissions:', error);
      throw error;
    }
  }

  /** Есть ли в объекте конфига учётные данные для запроса баланса / API. */
  _hasCredentialsForBalance(type, cfg) {
    if (!cfg || typeof cfg !== 'object') return false;
    if (type === 'ozon') {
      const c = String(cfg.client_id ?? cfg.clientId ?? '').trim();
      const k = String(cfg.api_key ?? cfg.apiKey ?? '').trim();
      return !!(c && k);
    }
    if (type === 'wildberries') {
      const raw = cfg.api_key ?? cfg.apiKey;
      return !!(raw && this._normalizeWbToken(raw));
    }
    if (type === 'yandex') {
      return !!this._normalizeYandexApiKey(cfg.api_key ?? cfg.apiKey);
    }
    return false;
  }

  /**
   * Первый активный кабинет маркетплейса по организациям профиля (для подписи источника и конфига).
   * @returns {Promise<null|{ config: object, cabinetId: number, cabinetName: string|null, organizationId: number, organizationName: string|null }>}
   * @private
   */
  async _getFirstCabinetBalanceRow(marketplaceType, profileId) {
    if (!this.usePostgreSQL || profileId == null || profileId === '') return null;
    try {
      const result = await query(
        `SELECT mc.id AS cabinet_id,
                mc.name AS cabinet_name,
                mc.config AS config,
                o.id AS organization_id,
                o.name AS organization_name
         FROM marketplace_cabinets mc
         INNER JOIN organizations o ON o.id = mc.organization_id
         WHERE o.profile_id = $1
           AND mc.marketplace_type = $2
           AND COALESCE(mc.is_active, true) = true
         ORDER BY o.name ASC NULLS LAST, mc.sort_order ASC NULLS LAST, mc.id ASC
         LIMIT 1`,
        [profileId, marketplaceType]
      );
      const row = result.rows[0];
      if (!row) return null;
      const raw = row.config;
      const parsed =
        this._safeParseJsonMaybe(raw) ?? (raw && typeof raw === 'object' ? raw : null);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        config: parsed,
        cabinetId: row.cabinet_id,
        cabinetName: row.cabinet_name != null ? String(row.cabinet_name) : null,
        organizationId: row.organization_id,
        organizationName: row.organization_name != null ? String(row.organization_name) : null
      };
    } catch (e) {
      logger.warn('[Integrations Service] marketplace_cabinets config lookup:', e?.message || e);
      return null;
    }
  }

  /**
   * Подпись источника данных для баланса (профиль или организация + кабинет).
   * @private
   */
  _balanceContextPayload(keysSource, cabinetMeta) {
    if (keysSource === 'integrations') {
      return {
        contextDescription: 'Профиль: общие интеграции (без привязки к организации)',
        organizationId: null,
        organizationName: null,
        cabinetId: null,
        cabinetName: null
      };
    }
    if (keysSource === 'marketplace_cabinet' && cabinetMeta && typeof cabinetMeta === 'object') {
      const org = String(cabinetMeta.organizationName || '').trim() || '—';
      const cab = String(cabinetMeta.cabinetName || '').trim() || 'Кабинет';
      return {
        contextDescription: `Организация «${org}», кабинет «${cab}»`,
        organizationId: cabinetMeta.organizationId ?? null,
        organizationName: org,
        cabinetId: cabinetMeta.cabinetId ?? null,
        cabinetName: cab
      };
    }
    return {
      contextDescription: null,
      organizationId: null,
      organizationName: null,
      cabinetId: null,
      cabinetName: null
    };
  }

  /**
   * Конфиг для баланса: сначала integrations по profile_id, иначе кабинет организации этого профиля.
   * @returns {Promise<{ config: object, source: 'integrations'|'marketplace_cabinet'|'none', cabinetMeta: object|null }>}
   */
  async _resolveMarketplaceConfigForBalance(type, profileId) {
    const fromInt = await this.getMarketplaceConfig(type, { profileId });
    if (this._hasCredentialsForBalance(type, fromInt)) {
      return {
        config: fromInt && typeof fromInt === 'object' ? fromInt : {},
        source: 'integrations',
        cabinetMeta: null
      };
    }
    const cabRow = await this._getFirstCabinetBalanceRow(type, profileId);
    if (cabRow && this._hasCredentialsForBalance(type, cabRow.config)) {
      return {
        config: cabRow.config,
        source: 'marketplace_cabinet',
        cabinetMeta: {
          organizationId: cabRow.organizationId,
          organizationName: cabRow.organizationName,
          cabinetId: cabRow.cabinetId,
          cabinetName: cabRow.cabinetName
        }
      };
    }
    return {
      config: fromInt && typeof fromInt === 'object' ? fromInt : {},
      source: 'none',
      cabinetMeta: null
    };
  }

  /**
   * Ozon: «конец периода» из отчёта движения средств (ближе всего к балансу в ЛК; не кошелёк рекламы).
   * @private
   */
  _ozonExtractEndBalanceFromCashFlowPayload(data) {
    const result = data?.result ?? data;
    if (!result || typeof result !== 'object') return { value: null, periodEndMs: 0 };

    const candidates = [];
    const pushDetail = (det) => {
      if (!det || typeof det !== 'object') return;
      const end = Number(det.end_balance_amount);
      if (!Number.isFinite(end)) return;
      const pend = det.period?.end ?? det.period_end;
      const ts = pend ? new Date(pend).getTime() : 0;
      candidates.push({ end, ts: Number.isFinite(ts) ? ts : 0 });
    };

    const rootDetails = result.details;
    if (Array.isArray(rootDetails)) rootDetails.forEach(pushDetail);
    else pushDetail(rootDetails);

    const flows = result.cash_flows;
    if (Array.isArray(flows)) {
      for (const row of flows) {
        if (row?.details) {
          if (Array.isArray(row.details)) row.details.forEach(pushDetail);
          else pushDetail(row.details);
        }
      }
    }

    if (candidates.length === 0) return { value: null, periodEndMs: 0 };
    candidates.sort((a, b) => a.ts - b.ts);
    const best = candidates[candidates.length - 1];
    return { value: best.end, periodEndMs: best.ts };
  }

  /**
   * Ozon: баланс по отчёту cash-flow-statement за текущий календарный месяц (агрегат по страницам).
   * @param {number|string|null} profileId
   * @param {object|null} [ozonOverride] — явный конфиг (например из marketplace_cabinets)
   * @param {string} [cacheContextId='profile'] — суффикс кэша (разные кабинеты / профиль)
   */
  async _fetchOzonCashFlowEndBalance(profileId, ozonOverride = null, cacheContextId = 'profile') {
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const ctx = String(cacheContextId || 'profile').replace(/[^\w:.-]/g, '_').slice(0, 80);
    const cacheKey = `ozon_cash_flow_end:${profileId ?? 'default'}:${monthKey}:${ctx}`;
    const cached = await this._cacheGet({ cache_type: 'marketplace_balance', cache_key: cacheKey });
    if (cached && typeof cached === 'object' && Number.isFinite(Number(cached.amountRub))) {
      return Number(cached.amountRub);
    }

    let bestEnd = null;
    let bestTs = 0;
    const pageCountMax = 25;
    for (let page = 1; page <= pageCountMax; page++) {
      const data = await this._ozonApiPost(
        '/v1/finance/cash-flow-statement/list',
        {
          date: { from: from.toISOString(), to: to.toISOString() },
          with_details: true,
          page,
          page_size: 50
        },
        ozonOverride && typeof ozonOverride === 'object'
          ? { profileId, ozonOverride }
          : { profileId }
      );
      const { value, periodEndMs } = this._ozonExtractEndBalanceFromCashFlowPayload(data);
      if (value != null && periodEndMs >= bestTs) {
        bestTs = periodEndMs;
        bestEnd = value;
      }
      const result = data?.result ?? data;
      const pc = Number(result?.page_count);
      if (Number.isFinite(pc) && pc > 0 && page >= pc) break;
    }

    if (bestEnd == null || !Number.isFinite(bestEnd)) return null;
    await this._cacheSet({
      cache_type: 'marketplace_balance',
      cache_key: cacheKey,
      cache_value: { amountRub: bestEnd, at: new Date().toISOString() },
      ttl_ms: 5 * 60 * 1000
    });
    return bestEnd;
  }

  /**
   * Wildberries Finance API: баланс продавца (нужна категория «Финансы» у токена). Лимит ~1 запрос / мин.
   * @param {number|string|null} profileId
   * @param {object|null} [wbOverride] — явный конфиг (например из marketplace_cabinets)
   * @param {string} [cacheContextId='profile'] — суффикс кэша (разные кабинеты / профиль)
   */
  async _fetchWildberriesFinanceBalance(profileId, wbOverride = null, cacheContextId = 'profile') {
    const ctx = String(cacheContextId || 'profile').replace(/[^\w:.-]/g, '_').slice(0, 80);
    const cacheKey = `wb_finance_balance:${profileId ?? 'default'}:${ctx}`;
    const cached = await this._cacheGet({ cache_type: 'marketplace_balance', cache_key: cacheKey });
    if (cached && typeof cached === 'object') return cached;

    const config =
      wbOverride && typeof wbOverride === 'object'
        ? wbOverride
        : await this.getMarketplaceConfig('wildberries', { profileId });
    const apiKey = this._normalizeWbToken(config?.api_key ?? config?.apiKey);
    if (!apiKey) {
      const err = new Error('API ключ Wildberries не настроен');
      err.statusCode = 400;
      throw err;
    }

    const fetch = (await import('node-fetch')).default;
    const url = 'https://finance-api.wildberries.ru/api/v1/account/balance';
    const authHeader = `Bearer ${apiKey}`;
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: authHeader }
      });
    } catch (e) {
      throw new Error('Не удалось связаться с Finance API Wildberries. Проверьте сеть.');
    }

    const text = await response.text().catch(() => '');
    if (response.status === 429) {
      throw new Error('Wildberries: лимит запросов баланса (не чаще 1 раза в минуту). Подождите и обновите.');
    }
    if (!response.ok) {
      let detail = text?.substring(0, 400) || '';
      try {
        const j = JSON.parse(text);
        detail = String(j?.detail || j?.message || detail);
      } catch (_) {}
      const low = detail.toLowerCase();
      if (response.status === 401 || response.status === 403) {
        if (low.includes('scope') || low.includes('not allowed')) {
          throw new Error('Wildberries: для баланса нужен токен с категорией «Финансы» (Finance) в ЛК WB → Доступ к API.');
        }
        throw new Error('Wildberries: Finance API не авторизовал запрос. Проверьте токен.');
      }
      throw new Error(`Wildberries Finance API: ${response.status}${detail ? ` — ${detail}` : ''}`);
    }

    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch (_) {
      body = {};
    }
    const out = {
      currency: body.currency != null ? String(body.currency) : 'RUB',
      currentRub: Number(body.current),
      forWithdrawRub: Number(body.for_withdraw),
      extraAmounts: this._wbParseExtraBalanceAmounts(body)
    };
    if (!Number.isFinite(out.currentRub)) out.currentRub = null;
    if (!Number.isFinite(out.forWithdrawRub)) out.forWithdrawRub = null;

    await this._cacheSet({
      cache_type: 'marketplace_balance',
      cache_key: cacheKey,
      cache_value: out,
      ttl_ms: 55 * 1000
    });
    return out;
  }

  /**
   * Балансы по маркетплейсам для дашборда (Ozon — отчёт о движении средств; WB — Finance API; Я.Маркет — нет аналога в Partner API).
   * @param {{ profileId?: number|string|null }} opts
   */
  async getMarketplaceAccountBalances(opts = {}) {
    const profileId = opts.profileId ?? opts.profile_id ?? null;

    const {
      config: ozonCfg,
      source: ozonKeysSource,
      cabinetMeta: ozonCabinetMeta
    } = await this._resolveMarketplaceConfigForBalance('ozon', profileId);
    const ozonConfigured = ozonKeysSource !== 'none';
    const ozonCtx = this._balanceContextPayload(ozonKeysSource, ozonCabinetMeta);
    const ozonCacheId =
      ozonKeysSource === 'marketplace_cabinet' && ozonCabinetMeta?.cabinetId != null
        ? `cabinet:${ozonCabinetMeta.cabinetId}`
        : 'profile';

    const {
      config: wbCfg,
      source: wbKeysSource,
      cabinetMeta: wbCabinetMeta
    } = await this._resolveMarketplaceConfigForBalance('wildberries', profileId);
    const wbConfigured = wbKeysSource !== 'none';
    const wbCtx = this._balanceContextPayload(wbKeysSource, wbCabinetMeta);
    const wbCacheId =
      wbKeysSource === 'marketplace_cabinet' && wbCabinetMeta?.cabinetId != null
        ? `cabinet:${wbCabinetMeta.cabinetId}`
        : 'profile';

    const {
      config: yandexCfg,
      source: yandexKeysSource,
      cabinetMeta: yandexCabinetMeta
    } = await this._resolveMarketplaceConfigForBalance('yandex', profileId);
    const yandexConfigured = yandexKeysSource !== 'none';
    const yandexCtx = this._balanceContextPayload(yandexKeysSource, yandexCabinetMeta);

    const ozon = {
      configured: ozonConfigured,
      amountRub: null,
      error: null,
      source: 'ozon_finance_cash_flow',
      keysSource: ozonKeysSource,
      ...ozonCtx
    };
    const wildberries = {
      configured: wbConfigured,
      currentRub: null,
      forWithdrawRub: null,
      currency: null,
      extraAmounts: [],
      error: null,
      source: 'wb_finance_api_v1_account_balance',
      keysSource: wbKeysSource,
      ...wbCtx
    };
    const yandex = {
      configured: yandexConfigured,
      available: false,
      keysSource: yandexKeysSource,
      ...yandexCtx,
      campaignSnapshot: null,
      snapshotError: null,
      message:
        'В Partner API нет одной суммы «баланс» в рублях (как у Ozon/WB). Ниже — данные магазина по campaign_id; деньги — в личном кабинете Маркета.'
    };

    const tasks = [];
    if (ozonConfigured) {
      tasks.push(
        (async () => {
          try {
            const override =
              ozonKeysSource === 'marketplace_cabinet' && ozonCfg && typeof ozonCfg === 'object' ? ozonCfg : null;
            ozon.amountRub = await this._fetchOzonCashFlowEndBalance(profileId, override, ozonCacheId);
          } catch (e) {
            ozon.error = e?.message || String(e);
          }
        })()
      );
    }
    if (wbConfigured) {
      tasks.push(
        (async () => {
          try {
            const override =
              wbKeysSource === 'marketplace_cabinet' && wbCfg && typeof wbCfg === 'object' ? wbCfg : null;
            const b = await this._fetchWildberriesFinanceBalance(profileId, override, wbCacheId);
            wildberries.currentRub = b.currentRub;
            wildberries.forWithdrawRub = b.forWithdrawRub;
            wildberries.currency = b.currency;
            wildberries.extraAmounts = Array.isArray(b.extraAmounts) ? b.extraAmounts : [];
          } catch (e) {
            wildberries.error = e?.message || String(e);
          }
        })()
      );
    }
    if (yandexConfigured) {
      tasks.push(
        (async () => {
          try {
            const override =
              yandexKeysSource === 'marketplace_cabinet' && yandexCfg && typeof yandexCfg === 'object'
                ? yandexCfg
                : null;
            const cfg = override || yandexCfg || {};
            const cid = cfg.campaign_id ?? cfg.campaignId ?? null;
            const apiKey = cfg.api_key ?? cfg.apiKey;
            if (cid == null || String(cid).trim() === '') {
              yandex.snapshotError =
                'Укажите campaign_id (ID магазина) в интеграции — тогда здесь отобразится название и домен магазина.';
              return;
            }
            yandex.campaignSnapshot = await this._fetchYandexCampaignSnapshot(cid, apiKey);
          } catch (e) {
            yandex.snapshotError = e?.message || String(e);
          }
        })()
      );
    }

    await Promise.all(tasks);

    return {
      ozon,
      wildberries,
      yandex
    };
  }
}

export default new IntegrationsService();

