/**
 * Ночные задачи по локальному времени профиля (IANA timezone).
 * Тик раз в 5 минут (UTC): для каждого профиля, чьё локальное HH:MM попало в окно — прогон.
 */

import logger from '../utils/logger.js';
import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import {
  DEFAULT_PROFILE_TIMEZONE,
  getZonedClockParts,
  isInLocalDailyWindow,
  normalizeProfileTimezone,
  parseDailyCronHm,
} from '../utils/profileTimezone.js';
import marketplaceFboReportsService from './marketplaceFboReports.service.js';
import marketplaceFbsReportsService from './marketplaceFbsReports.service.js';
import marketplaceProductCardPull from './marketplaceProductCardPull.service.js';
import { runMarketplaceInventoryDailySnapshot } from './marketplaceInventorySnapshots.service.js';
import integrationsService from './integrations.service.js';
import { runOrdersArchiveBlocking } from './ordersArchive.job.js';
import { addRuntimeNotification } from '../utils/runtime-notifications.js';

function envFlagEnabled(name, defaultOn = true) {
  const v = process.env[name];
  if (v == null || String(v).trim() === '') return defaultOn;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

function envCron(name, fallback) {
  const c = process.env[name];
  return c && String(c).trim() ? String(c).trim() : fallback;
}

function reportsDailyDateRangeYmd(daysBack = 7, timeZone = DEFAULT_PROFILE_TIMEZONE) {
  const clock = getZonedClockParts(new Date(), timeZone);
  const [y, m, d] = clock.ymd.split('-').map(Number);
  const to = new Date(Date.UTC(y, m - 1, d));
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - daysBack);
  const fmt = (dt) => {
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  };
  return { dateFrom: fmt(from), dateTo: fmt(to) };
}

async function tryClaimNightlyRun(jobKey, scopeKey, runLocalDate) {
  const r = await query(
    `INSERT INTO profile_nightly_job_runs (job_key, scope_key, run_local_date)
     VALUES ($1, $2, $3::date)
     ON CONFLICT (job_key, scope_key, run_local_date) DO NOTHING
     RETURNING job_key`,
    [jobKey, scopeKey, runLocalDate]
  );
  return Boolean(r.rows?.[0]);
}

async function loadProfilesWithTimezone() {
  const rows = await repositoryFactory.getProfilesRepository().findAll();
  return (rows || [])
    .map((r) => ({
      id: Number(r.id),
      timezone: normalizeProfileTimezone(r.timezone ?? r.time_zone),
    }))
    .filter((p) => Number.isFinite(p.id) && p.id > 0);
}

async function syncReportsForProfile(service, label, profileId, timeZone) {
  const { dateFrom, dateTo } = reportsDailyDateRangeYmd(7, timeZone);
  const out = await service.sync({ profileId, dateFrom, dateTo, marketplace: 'all' });
  const imported = (out?.results || []).reduce((s, r) => s + (Number(r.rowsImported) || 0), 0);
  logger.info(`[NightlyTZ] ${label} done`, { profileId, dateFrom, dateTo, imported });
  return out;
}

async function runApiCheckForProfile(profileId) {
  const marketplaces = ['ozon', 'wildberries', 'yandex'];
  for (const code of marketplaces) {
    try {
      const config = await integrationsService.getMarketplaceConfig(code, { profileId });
      const ozonApiKey = config?.api_key ?? config?.apiKey;
      const ozonClient = config?.client_id ?? config?.clientId;
      const hasOzonKeys =
        ozonClient &&
        String(ozonClient).trim() !== '' &&
        ozonApiKey != null &&
        String(ozonApiKey).trim() !== '';
      const simpleKey = config?.api_key ?? config?.apiKey;
      const hasSimpleKey = simpleKey != null && String(simpleKey).trim() !== '';
      const hasKey = code === 'ozon' ? hasOzonKeys : hasSimpleKey;
      if (!hasKey) continue;
      await integrationsService.getMarketplaceTokenStatus(code, { profileId });
      logger.info(`[NightlyTZ] API check ok: ${code} profile=${profileId}`);
    } catch (error) {
      logger.warn(
        `[NightlyTZ] API check failed for ${code} profile=${profileId}:`,
        error?.message || error
      );
    }
  }
}

/**
 * Описание ночных задач: localHm из прежних cron (МСК), теперь — локальное время профиля.
 */
function buildNightlyJobs() {
  /** @type {Array<{ key: string, enabled: boolean, cron: string, fallbackHm: {hour:number,minute:number}, scope: 'profile'|'timezone', run: Function }>} */
  const jobs = [];

  if (envFlagEnabled('MP_CARD_PULL_DAILY_ENABLED', true)) {
    jobs.push({
      key: 'marketplace-card-pull-daily',
      enabled: true,
      cron: envCron('MP_CARD_PULL_DAILY_CRON', '40 3 * * *'),
      fallbackHm: { hour: 3, minute: 40 },
      scope: 'profile',
      run: async ({ profileId }) => {
        await marketplaceProductCardPull.pullDailyMarketplaceCardsForEnabledOrgs({ profileId });
      },
    });
  }

  if (envFlagEnabled('ORDERS_ARCHIVE_ENABLED', true)) {
    jobs.push({
      key: 'orders-archive',
      enabled: true,
      cron: envCron('ORDERS_ARCHIVE_CRON', '45 3 * * *'),
      fallbackHm: { hour: 3, minute: 45 },
      scope: 'profile',
      run: async ({ profileId }) => {
        const result = await runOrdersArchiveBlocking({ profileId });
        logger.info('[NightlyTZ] Orders archive', { profileId, ...result });
      },
    });
  }

  if (envFlagEnabled('MP_INVENTORY_DAILY_ENABLED', true)) {
    jobs.push({
      key: 'marketplace-inventory-daily',
      enabled: true,
      cron: envCron('MP_INVENTORY_DAILY_CRON', '30 4 * * *'),
      fallbackHm: { hour: 4, minute: 30 },
      scope: 'profile',
      run: async ({ profileId }) => {
        await runMarketplaceInventoryDailySnapshot({ profileId });
      },
    });
  }

  if (envFlagEnabled('MP_FBO_REPORTS_DAILY_ENABLED', true)) {
    jobs.push({
      key: 'marketplace-fbo-reports-daily',
      enabled: true,
      cron: envCron('MP_FBO_REPORTS_DAILY_CRON', '0 5 * * *'),
      fallbackHm: { hour: 5, minute: 0 },
      scope: 'profile',
      run: async ({ profileId, timeZone }) => {
        await syncReportsForProfile(
          marketplaceFboReportsService,
          'Marketplace FBO reports',
          profileId,
          timeZone
        );
      },
    });
  }

  if (envFlagEnabled('MP_FBS_REPORTS_DAILY_ENABLED', true)) {
    jobs.push({
      key: 'marketplace-fbs-reports-daily',
      enabled: true,
      cron: envCron('MP_FBS_REPORTS_DAILY_CRON', '20 5 * * *'),
      fallbackHm: { hour: 5, minute: 20 },
      scope: 'profile',
      run: async ({ profileId, timeZone }) => {
        await syncReportsForProfile(
          marketplaceFbsReportsService,
          'Marketplace FBS reports',
          profileId,
          timeZone
        );
      },
    });
  }

  if (envFlagEnabled('BUYOUT_RATE_DAILY_ENABLED', true)) {
    jobs.push({
      key: 'buyout-rate-daily',
      enabled: true,
      cron: envCron('BUYOUT_RATE_DAILY_CRON', '40 5 * * *'),
      fallbackHm: { hour: 5, minute: 40 },
      scope: 'profile',
      run: async ({ profileId }) => {
        const { recalculateBuyoutRatesForProfile } = await import('./buyoutRateDaily.service.js');
        const result = await recalculateBuyoutRatesForProfile(profileId);
        logger.info('[NightlyTZ] Buyout rate daily', { profileId, ...result });
      },
    });
  }

  jobs.push({
    key: 'marketplace-api-check',
    enabled: true,
    cron: '0 6 * * *',
    fallbackHm: { hour: 6, minute: 0 },
    scope: 'profile',
    run: async ({ profileId }) => {
      await runApiCheckForProfile(profileId);
    },
  });

  if (envFlagEnabled('CACHE_ENTRIES_CLEAR_EXPIRED_ENABLED', true)) {
    jobs.push({
      key: 'cache-entries-clear-expired',
      enabled: true,
      cron: envCron('CACHE_ENTRIES_CLEAR_EXPIRED_CRON', '50 3 * * *'),
      fallbackHm: { hour: 3, minute: 50 },
      scope: 'timezone',
      run: async () => {
        if (!repositoryFactory.isUsingPostgreSQL()) return;
        const deleted = await repositoryFactory.getCacheEntriesRepository().clearExpired();
        logger.info('[NightlyTZ] cache_entries clearExpired', { deleted: Number(deleted) || 0 });
      },
    });
  }

  if (envFlagEnabled('WB_CLOSED_SHIPMENTS_PRUNE_ENABLED', true)) {
    jobs.push({
      key: 'wb-closed-shipments-prune',
      enabled: true,
      cron: envCron('WB_CLOSED_SHIPMENTS_PRUNE_CRON', '55 3 * * *'),
      fallbackHm: { hour: 3, minute: 55 },
      scope: 'timezone',
      run: async () => {
        const { pruneExpiredClosedWbShipments, wbClosedShipmentRetentionDays } = await import(
          './shipments.service.js'
        );
        const result = await pruneExpiredClosedWbShipments({
          days: wbClosedShipmentRetentionDays(),
        });
        logger.info('[NightlyTZ] WB closed shipments prune', result);
      },
    });
  }

  return jobs;
}

let tickInFlight = false;

/**
 * Один тик диспетчера (вызывать каждые ~5 мин).
 */
export async function runProfileNightlyDispatcherTick(now = new Date()) {
  if (!repositoryFactory.isUsingPostgreSQL()) return { skipped: true, reason: 'not_pg' };
  if (tickInFlight) return { skipped: true, reason: 'in_flight' };
  tickInFlight = true;
  const started = Date.now();
  let claimed = 0;
  let ran = 0;
  let failed = 0;
  try {
    const profiles = await loadProfilesWithTimezone();
    if (!profiles.length) return { profiles: 0, claimed: 0, ran: 0 };
    const jobs = buildNightlyJobs();
    const windowMinutes = Math.max(
      1,
      Number(process.env.PROFILE_NIGHTLY_WINDOW_MINUTES || 5) || 5
    );

    for (const profile of profiles) {
      const clock = getZonedClockParts(now, profile.timezone);
      for (const job of jobs) {
        if (!job.enabled) continue;
        const hm = parseDailyCronHm(job.cron, job.fallbackHm);
        if (!isInLocalDailyWindow(clock, hm, windowMinutes)) continue;

        const scopeKey =
          job.scope === 'timezone' ? `tz:${profile.timezone}` : `p:${profile.id}`;
        const okClaim = await tryClaimNightlyRun(job.key, scopeKey, clock.ymd);
        if (!okClaim) continue;
        claimed += 1;
        try {
          logger.info('[NightlyTZ] run', {
            job: job.key,
            profileId: profile.id,
            timeZone: profile.timezone,
            local: `${clock.ymd} ${String(hm.hour).padStart(2, '0')}:${String(hm.minute).padStart(2, '0')}`,
          });
          await job.run({
            profileId: profile.id,
            timeZone: profile.timezone,
            localYmd: clock.ymd,
          });
          ran += 1;
        } catch (e) {
          failed += 1;
          logger.error('[NightlyTZ] job failed', {
            job: job.key,
            profileId: profile.id,
            error: e?.message || String(e),
          });
          await addRuntimeNotification({
            type: 'job_failed',
            severity: 'warning',
            source: 'scheduler',
            title: `Сбой ночной задачи (${job.key})`,
            message: `profile=${profile.id} tz=${profile.timezone}: ${e?.message || e}`,
          }).catch(() => {});
        }
      }
    }

    return {
      profiles: profiles.length,
      claimed,
      ran,
      failed,
      durationMs: Date.now() - started,
    };
  } finally {
    tickInFlight = false;
  }
}

export function getProfileNightlyDispatcherCron() {
  const c = process.env.PROFILE_NIGHTLY_DISPATCH_CRON;
  return c && String(c).trim() ? String(c).trim() : '*/5 * * * *';
}

export default {
  runProfileNightlyDispatcherTick,
  getProfileNightlyDispatcherCron,
};
