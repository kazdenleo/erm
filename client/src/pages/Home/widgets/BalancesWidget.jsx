/**
 * Виджет «Баланс на маркетплейсах».
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../../components/common/Button/Button';
import { integrationsApi } from '../../../services/integrations.api';
import { errorMessage, formatRub } from './widgetUtils';

/** К какой организации относится строка баланса (ответ getMarketplaceAccountBalances). */
function marketplaceBalanceOrganizationLine(mp, balanceLoading) {
  if (balanceLoading) return '…';
  if (!mp?.configured) return '—';
  const org = mp.organizationName != null ? String(mp.organizationName).trim() : '';
  if (org && org !== '—') return `Организация: «${org}»`;
  if (mp.keysSource === 'integrations') return 'Общие интеграции профиля (без привязки к организации)';
  if (mp.keysSource === 'marketplace_cabinet') {
    const cab = mp.cabinetName != null ? String(mp.cabinetName).trim() : '';
    if (cab) return `Кабинет: «${cab}»`;
  }
  return '—';
}

function NotConfigured({ children }) {
  return (
    <div className="text-muted small text-end">
      <div className="mb-1">{children}</div>
      <Link to="/integrations">Открыть интеграции</Link>
    </div>
  );
}

export function BalancesWidget({ profileId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (profileId == null) {
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setData(await integrationsApi.getMarketplaceAccountBalances());
    } catch (e) {
      setError(errorMessage(e, 'Не удалось загрузить балансы'));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    load();
  }, [load]);

  const wb = data?.wildberries;
  const ym = data?.yandex;
  const snap = ym?.campaignSnapshot;

  return (
    <div className="card mb-0 home-marketplace-balances-card">
      <div className="card-header d-flex flex-wrap align-items-center justify-content-between gap-2">
        <div className="card-header-title mb-0">
          <i className="header-icon pe-7s-wallet icon-gradient bg-mean-fruit me-2" />
          Баланс на маркетплейсах
        </div>
        <Button
          type="button"
          variant="secondary"
          size="small"
          className="btn-wide"
          disabled={loading || profileId == null}
          onClick={() => load()}
        >
          {loading ? 'Загрузка…' : 'Обновить'}
        </Button>
      </div>
      <div className="card-body">
        <p className="text-muted small mb-3">
          Ключи API — из общих интеграций профиля или из кабинета организации («Интеграции»). Если кабинетов
          несколько, для цифр берётся один кабинет на маркетплейс (первый по названию организации и порядку
          кабинета). Под названием маркетплейса указано, к какой организации относятся данные. Ozon — отчёт
          «Движение средств» за текущий месяц; Wildberries — баланс из Finance API (категория «Финансы»),
          дополнительные суммы из ответа API при наличии; Яндекс Маркет — рублёвого баланса в API нет,
          показываются данные магазина по campaign_id.
        </p>
        {profileId == null && (
          <div className="text-muted mb-0" role="status">
            Балансы запрашиваются в контексте аккаунта (профиля). У текущего пользователя нет привязки к профилю —
            укажите её в настройках или зайдите под пользователем аккаунта.
          </div>
        )}
        {profileId != null && error && (
          <div className="alert alert-warning py-2 mb-3" role="alert">
            {error}
          </div>
        )}
        {profileId != null && data?.no_profile && (
          <div className="text-muted">Нет привязки к аккаунту — балансы недоступны.</div>
        )}
        {profileId != null && !data?.no_profile && (
          <div className="table-responsive">
            <table className="align-middle mb-0 table table-striped table-hover">
              <thead>
                <tr>
                  <th className="home-balance-mp-col">Маркетплейс</th>
                  <th className="text-end">Баланс</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="home-balance-mp-col">
                    <div>Ozon</div>
                    <div className="text-muted small mt-1">
                      {marketplaceBalanceOrganizationLine(data?.ozon, loading)}
                    </div>
                  </td>
                  <td className="text-end">
                    {loading ? (
                      '…'
                    ) : !data?.ozon?.configured ? (
                      <NotConfigured>
                        Не найдены <strong>Client ID</strong> и <strong>API Key</strong> Ozon ни в общих настройках
                        профиля, ни в кабинетах организаций.
                      </NotConfigured>
                    ) : data.ozon.error ? (
                      <span className="text-danger small">{data.ozon.error}</span>
                    ) : data.ozon.amountRub != null && Number.isFinite(Number(data.ozon.amountRub)) ? (
                      <span className="text-nowrap">{formatRub(Number(data.ozon.amountRub))}</span>
                    ) : (
                      <span className="text-muted">Нет данных в отчёте</span>
                    )}
                  </td>
                </tr>
                <tr>
                  <td className="home-balance-mp-col">
                    <div>Wildberries</div>
                    <div className="text-muted small mt-1">{marketplaceBalanceOrganizationLine(wb, loading)}</div>
                  </td>
                  <td className="text-end">
                    {loading ? (
                      '…'
                    ) : !wb?.configured ? (
                      <NotConfigured>
                        Не найден <strong>API-токен</strong> Wildberries в настройках профиля или в кабинетах
                        организаций. Для баланса нужен токен с категорией <strong>«Финансы»</strong>.
                      </NotConfigured>
                    ) : wb.error ? (
                      <span className="text-danger small">{wb.error}</span>
                    ) : (
                      <div className="d-inline-block text-end">
                        <div className="text-nowrap">
                          <span className="text-muted small me-1">На счёте:</span>
                          {formatRub(Number(wb.currentRub))}
                        </div>
                        {wb.forWithdrawRub != null && Number.isFinite(Number(wb.forWithdrawRub)) && (
                          <div className="text-nowrap">
                            <span className="text-muted small me-1">К выводу:</span>
                            {formatRub(Number(wb.forWithdrawRub))}
                          </div>
                        )}
                        {(wb.extraAmounts ?? []).map((row) => (
                          <div key={row.key} className="text-nowrap small" title={row.key}>
                            <span className="text-muted me-1">{row.label}:</span>
                            {formatRub(Number(row.amountRub))}
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
                <tr>
                  <td className="home-balance-mp-col">
                    <div>Яндекс Маркет</div>
                    <div className="text-muted small mt-1">{marketplaceBalanceOrganizationLine(ym, loading)}</div>
                  </td>
                  <td className="text-end">
                    {loading ? (
                      '…'
                    ) : !ym?.configured ? (
                      <NotConfigured>
                        Не найден <strong>Api-Key</strong> Partner API Яндекс.Маркета в настройках профиля или в
                        кабинетах организаций.
                      </NotConfigured>
                    ) : (
                      <div className="d-inline-block text-end">
                        {ym.snapshotError && <div className="text-warning small mb-1">{ym.snapshotError}</div>}
                        {snap && (
                          <div className="small text-end">
                            {snap.businessName && <div className="fw-semibold">{snap.businessName}</div>}
                            {snap.domain && <div className="text-muted">{snap.domain}</div>}
                            {(snap.placementType || snap.campaignId != null) && (
                              <div className="text-muted">
                                {snap.placementType && <span>{snap.placementType}</span>}
                                {snap.placementType && snap.campaignId != null && ' · '}
                                {snap.campaignId != null && <span>ID {snap.campaignId}</span>}
                              </div>
                            )}
                          </div>
                        )}
                        <div className="text-muted small mt-1">{ym.message}</div>
                      </div>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
