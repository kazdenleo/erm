/**
 * Первичный онбординг после регистрации:
 * организация → склад → ключи МП (можно пропустить) → готово.
 */

import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { organizationsApi } from '../../services/organizations.api.js';
import { warehousesApi } from '../../services/warehouses.api.js';
import { marketplaceCabinetsApi } from '../../services/marketplaceCabinets.api.js';
import { integrationsApi } from '../../services/integrations.api.js';
import { profilesApi } from '../../services/profiles.api.js';
import { setApiSessionContext } from '../../services/apiSession.js';
import { Button } from '../../components/common/Button/Button';
import '../Login/Login.css';
import './Onboarding.css';

const STEPS = [
  { id: 'org', title: 'Организация' },
  { id: 'warehouse', title: 'Склад' },
  { id: 'marketplaces', title: 'Маркетплейсы' },
  { id: 'done', title: 'Готово' },
];

const emptyMp = () => ({
  ozon: { enabled: false, client_id: '', api_key: '', status: null },
  wildberries: { enabled: false, api_key: '', status: null },
  yandex: { enabled: false, api_key: '', campaign_id: '', status: null },
});

export function Onboarding() {
  const navigate = useNavigate();
  const { user, refreshUser, setSelectedOrganizationId, profileId } = useAuth();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [orgName, setOrgName] = useState(user?.profile?.name || '');
  const [orgInn, setOrgInn] = useState('');
  const [organizationId, setOrganizationId] = useState(null);

  const [whName, setWhName] = useState('Основной склад');
  const [warehouseId, setWarehouseId] = useState(null);

  const [mp, setMp] = useState(emptyMp);

  const stepMeta = STEPS[step] || STEPS[0];
  const accountName = user?.profile?.name || 'ваш аккаунт';

  const progressLabel = useMemo(
    () => `Шаг ${step + 1} из ${STEPS.length}: ${stepMeta.title}`,
    [step, stepMeta.title]
  );

  const ensureOrgContext = (orgId) => {
    const oid = orgId != null ? String(orgId) : null;
    if (oid) {
      setSelectedOrganizationId?.(oid);
      setApiSessionContext({
        accountId: profileId != null ? String(profileId) : null,
        organizationId: oid,
      });
    }
  };

  const createOrganization = async () => {
    setError('');
    const name = String(orgName || '').trim();
    if (name.length < 2) {
      setError('Укажите название организации');
      return;
    }
    setBusy(true);
    try {
      const res = await organizationsApi.create({
        name,
        inn: String(orgInn || '').trim() || null,
      });
      const org = res?.data ?? res;
      const id = org?.id;
      if (!id) throw new Error('Организация не создана');
      setOrganizationId(id);
      ensureOrgContext(id);
      setStep(1);
    } catch (e) {
      setError(e?.response?.data?.message || e.message || 'Не удалось создать организацию');
    } finally {
      setBusy(false);
    }
  };

  const createWarehouse = async () => {
    setError('');
    if (!organizationId) {
      setError('Сначала создайте организацию');
      setStep(0);
      return;
    }
    const name = String(whName || '').trim();
    if (!name) {
      setError('Укажите название склада');
      return;
    }
    setBusy(true);
    try {
      ensureOrgContext(organizationId);
      const res = await warehousesApi.create({
        type: 'warehouse',
        name,
        organizationId,
        address: null,
      });
      const wh = res?.data ?? res;
      setWarehouseId(wh?.id ?? null);
      setStep(2);
    } catch (e) {
      setError(e?.response?.data?.message || e.message || 'Не удалось создать склад');
    } finally {
      setBusy(false);
    }
  };

  const saveMarketplace = async (type) => {
    setError('');
    if (!organizationId) {
      setError('Нет организации');
      return;
    }
    const row = mp[type];
    if (!row?.enabled) return;

    let config = {};
    if (type === 'ozon') {
      if (!row.client_id?.trim() || !row.api_key?.trim()) {
        setError('Ozon: укажите Client ID и API Key');
        return;
      }
      config = { client_id: row.client_id.trim(), api_key: row.api_key.trim() };
    } else if (type === 'wildberries') {
      if (!row.api_key?.trim()) {
        setError('Wildberries: укажите API-токен');
        return;
      }
      config = { api_key: row.api_key.trim() };
    } else if (type === 'yandex') {
      if (!row.api_key?.trim()) {
        setError('Яндекс.Маркет: укажите Api-Key');
        return;
      }
      config = {
        api_key: row.api_key.trim(),
        ...(row.campaign_id?.trim() ? { campaign_id: row.campaign_id.trim() } : {}),
      };
    }

    setBusy(true);
    try {
      ensureOrgContext(organizationId);
      await marketplaceCabinetsApi.create(organizationId, {
        marketplace_type: type,
        name:
          type === 'ozon' ? 'Ozon' : type === 'yandex' ? 'Яндекс.Маркет' : 'Wildberries',
        config,
      });
      let check = null;
      try {
        check = await integrationsApi.getMarketplaceTokenStatus(type);
      } catch {
        check = { ok: false, message: 'Кабинет сохранён, проверку токена не удалось выполнить' };
      }
      const ok = check?.ok === true || check?.valid === true;
      setMp((prev) => ({
        ...prev,
        [type]: {
          ...prev[type],
          status: ok
            ? { ok: true, message: check?.message || 'Токен принят' }
            : {
                ok: false,
                message:
                  check?.message ||
                  check?.reason ||
                  'Сохранено. Проверьте ключ позже в «Интеграциях».',
              },
        },
      }));
    } catch (e) {
      setMp((prev) => ({
        ...prev,
        [type]: {
          ...prev[type],
          status: {
            ok: false,
            message: e?.response?.data?.message || e.message || 'Ошибка сохранения',
          },
        },
      }));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setError('');
    setBusy(true);
    try {
      await profilesApi.completeOnboarding();
      if (typeof refreshUser === 'function') {
        await refreshUser();
      }
      setStep(3);
    } catch (e) {
      setError(e?.response?.data?.message || e.message || 'Не удалось завершить настройку');
    } finally {
      setBusy(false);
    }
  };

  const goHome = () => navigate('/', { replace: true });

  return (
    <div className="onboarding-page">
      <div className="onboarding-card card">
        <div className="onboarding-brand">
          <Link to="/">Программа Ирина</Link>
        </div>
        <h1 className="onboarding-title">Настройка аккаунта</h1>
        <p className="onboarding-lead">
          {accountName}: за пару минут подключим базу, чтобы можно было работать с заказами и
          остатками.
        </p>
        <div className="onboarding-steps" aria-label={progressLabel}>
          {STEPS.map((s, i) => (
            <div
              key={s.id}
              className={`onboarding-step-pill${i === step ? ' is-active' : ''}${
                i < step ? ' is-done' : ''
              }`}
            >
              {i + 1}. {s.title}
            </div>
          ))}
        </div>
        {error ? <div className="login-error">{error}</div> : null}

        {step === 0 && (
          <div className="onboarding-panel">
            <p className="text-muted small">
              Организация — юрлицо или ИП, к которому привязываются кабинеты маркетплейсов.
            </p>
            <label className="login-label">
              Название
              <input
                className="login-input"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="Например: ИП Иванов"
                autoFocus
              />
            </label>
            <label className="login-label">
              ИНН <span className="text-muted">(необязательно)</span>
              <input
                className="login-input"
                value={orgInn}
                onChange={(e) => setOrgInn(e.target.value)}
                placeholder="10 или 12 цифр"
              />
            </label>
            <Button type="button" variant="primary" disabled={busy} onClick={createOrganization}>
              {busy ? 'Сохранение…' : 'Далее'}
            </Button>
          </div>
        )}

        {step === 1 && (
          <div className="onboarding-panel">
            <p className="text-muted small">
              Склад, с которого будете отгружать FBS и считать остатки. Позже можно добавить ещё.
            </p>
            <label className="login-label">
              Название склада
              <input
                className="login-input"
                value={whName}
                onChange={(e) => setWhName(e.target.value)}
                autoFocus
              />
            </label>
            <div className="onboarding-actions">
              <Button type="button" variant="secondary" disabled={busy} onClick={() => setStep(0)}>
                Назад
              </Button>
              <Button type="button" variant="primary" disabled={busy} onClick={createWarehouse}>
                {busy ? 'Сохранение…' : 'Далее'}
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="onboarding-panel">
            <p className="text-muted small">
              Подключите хотя бы один кабинет — или пропустите и сделайте это позже в «Интеграциях».
            </p>

            {[
              {
                key: 'ozon',
                label: 'Ozon',
                fields: (
                  <>
                    <label className="login-label">
                      Client ID
                      <input
                        className="login-input"
                        value={mp.ozon.client_id}
                        onChange={(e) =>
                          setMp((p) => ({
                            ...p,
                            ozon: { ...p.ozon, client_id: e.target.value },
                          }))
                        }
                      />
                    </label>
                    <label className="login-label">
                      API Key
                      <input
                        className="login-input"
                        type="password"
                        value={mp.ozon.api_key}
                        onChange={(e) =>
                          setMp((p) => ({
                            ...p,
                            ozon: { ...p.ozon, api_key: e.target.value },
                          }))
                        }
                      />
                    </label>
                  </>
                ),
              },
              {
                key: 'wildberries',
                label: 'Wildberries',
                fields: (
                  <label className="login-label">
                    API-токен
                    <input
                      className="login-input"
                      type="password"
                      value={mp.wildberries.api_key}
                      onChange={(e) =>
                        setMp((p) => ({
                          ...p,
                          wildberries: { ...p.wildberries, api_key: e.target.value },
                        }))
                      }
                    />
                  </label>
                ),
              },
              {
                key: 'yandex',
                label: 'Яндекс.Маркет',
                fields: (
                  <>
                    <label className="login-label">
                      Api-Key
                      <input
                        className="login-input"
                        type="password"
                        value={mp.yandex.api_key}
                        onChange={(e) =>
                          setMp((p) => ({
                            ...p,
                            yandex: { ...p.yandex, api_key: e.target.value },
                          }))
                        }
                      />
                    </label>
                    <label className="login-label">
                      campaignId <span className="text-muted">(необязательно)</span>
                      <input
                        className="login-input"
                        value={mp.yandex.campaign_id}
                        onChange={(e) =>
                          setMp((p) => ({
                            ...p,
                            yandex: { ...p.yandex, campaign_id: e.target.value },
                          }))
                        }
                      />
                    </label>
                  </>
                ),
              },
            ].map((block) => (
              <div key={block.key} className="onboarding-mp-block">
                <label className="onboarding-mp-toggle">
                  <input
                    type="checkbox"
                    checked={mp[block.key].enabled}
                    onChange={(e) =>
                      setMp((p) => ({
                        ...p,
                        [block.key]: { ...p[block.key], enabled: e.target.checked },
                      }))
                    }
                  />
                  <strong>{block.label}</strong>
                </label>
                {mp[block.key].enabled ? (
                  <>
                    {block.fields}
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      disabled={busy}
                      onClick={() => saveMarketplace(block.key)}
                    >
                      Сохранить и проверить
                    </Button>
                    {mp[block.key].status ? (
                      <p
                        className={`small mb-0 ${
                          mp[block.key].status.ok ? 'text-success' : 'text-muted'
                        }`}
                      >
                        {mp[block.key].status.message}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            ))}

            <div className="onboarding-actions">
              <Button type="button" variant="secondary" disabled={busy} onClick={() => setStep(1)}>
                Назад
              </Button>
              <Button type="button" variant="primary" disabled={busy} onClick={finish}>
                {busy ? 'Сохранение…' : 'Завершить'}
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="onboarding-panel">
            <p>
              База готова
              {warehouseId ? ' (организация и склад созданы)' : ''}. Дальше обычно:
            </p>
            <ul>
              <li>
                <Link to="/products">Товары</Link> — каталог и привязка к МП
              </li>
              <li>
                <Link to="/integrations">Интеграции</Link> — донастроить ключи и кабинеты
              </li>
              <li>
                <Link to="/orders">Заказы</Link> — FBS после синка
              </li>
            </ul>
            <p className="text-muted small">
              Пробный период 7 дней уже идёт. Тарифы: <Link to="/pricing">/pricing</Link>.
            </p>
            <Button type="button" variant="primary" onClick={goHome}>
              Перейти в кабинет
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
