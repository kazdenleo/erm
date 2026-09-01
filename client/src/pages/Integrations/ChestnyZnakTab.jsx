import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { chestnyZnakApi } from '../../services/chestnyZnak.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import {
  createAttachedCadesBes,
  diagnoseCryptoProSetup,
  listCryptoProCertificates,
} from '../../utils/cryptoProSign.js';
import { ChestnyZnakSetupChecklist } from './ChestnyZnakSetupChecklist';
import { CHESTNY_ZNAK_OPERATIONS, mergeProductGroupOptions } from './chestnyZnakGroups';
import { invalidateChestnyZnakEnabled } from '../../hooks/useChestnyZnakEnabled.js';

function formatExpiry(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  return d.toLocaleString('ru-RU');
}

function isExpired(iso) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t <= Date.now();
}

function innDigits(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 12);
}

function isValidInn(value) {
  const d = innDigits(value);
  if (d.length !== 10 && d.length !== 12) return false;
  return !/^0+$/.test(d);
}

export function ChestnyZnakTab({
  organizations = [],
  selectedOrgId,
  onSelectOrg,
  onConfigChange,
}) {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const [sandbox, setSandbox] = useState(false);
  const [apiVersion, setApiVersion] = useState('v3');
  const [unitedToken, setUnitedToken] = useState(false);
  const [inn, setInn] = useState('');
  const [productGroups, setProductGroups] = useState(['tires']);
  const [operations, setOperations] = useState(() => (
    Object.fromEntries(CHESTNY_ZNAK_OPERATIONS.map((o) => [o.id, true]))
  ));
  const [manualToken, setManualToken] = useState('');
  const [omsOpen, setOmsOpen] = useState(false);
  const [omsId, setOmsId] = useState('');
  const [omsConnection, setOmsConnection] = useState('');
  const [omsToken, setOmsToken] = useState('');

  const [pluginOk, setPluginOk] = useState(null);
  const [setup, setSetup] = useState(null);
  const [setupChecking, setSetupChecking] = useState(false);
  const [certs, setCerts] = useState([]);
  const [certsLoading, setCertsLoading] = useState(false);
  const [thumbprint, setThumbprint] = useState('');
  const [signing, setSigning] = useState(false);
  const [testing, setTesting] = useState(false);

  const [cisText, setCisText] = useState('');
  const [cisChecking, setCisChecking] = useState(false);
  const [cisItems, setCisItems] = useState(null);
  const [groupQuery, setGroupQuery] = useState('');

  const selectedOrg = useMemo(
    () => (organizations || []).find((o) => String(o.id) === String(selectedOrgId)) || null,
    [organizations, selectedOrgId]
  );

  const innOptions = useMemo(() => {
    const seen = new Set();
    const list = [];
    for (const org of organizations || []) {
      const digits = innDigits(org.inn);
      if (!isValidInn(digits) || seen.has(digits)) continue;
      seen.add(digits);
      list.push({ id: org.id, name: org.name, inn: digits });
    }
    return list;
  }, [organizations]);

  const resolvedInn = inn || innDigits(selectedOrg?.inn);

  const groupOptions = useMemo(
    () => mergeProductGroupOptions(config?.productGroupOptions),
    [config]
  );
  const visibleGroupOptions = useMemo(() => {
    const q = groupQuery.trim().toLowerCase();
    if (!q) return groupOptions;
    return groupOptions.filter((g) => (
      String(g.name || '').toLowerCase().includes(q)
      || String(g.id || '').toLowerCase().includes(q)
    ));
  }, [groupOptions, groupQuery]);

  const applyConfig = useCallback((data) => {
    setConfig(data || {});
    setSandbox(Boolean(data?.sandbox));
    setApiVersion(data?.api_version === 'v4' ? 'v4' : 'v3');
    setUnitedToken(Boolean(data?.united_token));
    setInn(innDigits(data?.inn) || '');
    setProductGroups(Array.isArray(data?.product_groups) && data.product_groups.length
      ? data.product_groups
      : ['tires']);
    setOperations({
      ...Object.fromEntries(CHESTNY_ZNAK_OPERATIONS.map((o) => [o.id, true])),
      ...(data?.operations && typeof data.operations === 'object' ? data.operations : {}),
    });
    setThumbprint(data?.cert_thumbprint || '');
    setOmsId(data?.oms_id || '');
    setOmsConnection(data?.oms_connection || '');
    setOmsToken('');
    setManualToken('');
  }, []);

  const loadConfig = useCallback(async () => {
    if (!selectedOrgId) {
      setConfig(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await chestnyZnakApi.getConfig();
      applyConfig(data);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Не удалось загрузить настройки Честного знака'));
    } finally {
      setLoading(false);
    }
  }, [selectedOrgId, applyConfig]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (inn || !isValidInn(selectedOrg?.inn)) return;
    setInn(innDigits(selectedOrg.inn));
  }, [selectedOrg, inn]);

  const runSetupCheck = useCallback(async () => {
    setSetupChecking(true);
    try {
      const result = await diagnoseCryptoProSetup();
      setSetup(result);
      setPluginOk(Boolean(result.pluginReady));
      if (result.certificates?.length) {
        setCerts(result.certificates);
        setThumbprint((prev) => {
          if (prev) return prev;
          const preferred = result.certificates.find((c) => !c.expired) || result.certificates[0];
          return preferred?.thumbprint || '';
        });
      }
    } catch (err) {
      setPluginOk(false);
      setError(err?.message || 'Не удалось проверить КриптоПро');
    } finally {
      setSetupChecking(false);
    }
  }, []);

  useEffect(() => {
    runSetupCheck();
  }, [runSetupCheck]);

  const loadCerts = async () => {
    setCertsLoading(true);
    setError(null);
    try {
      const list = await listCryptoProCertificates();
      setCerts(list);
      setPluginOk(true);
      if (!thumbprint && list.length) {
        const preferred = list.find((c) => !c.expired) || list[0];
        setThumbprint(preferred.thumbprint);
      }
    } catch (err) {
      setPluginOk(false);
      setError(err?.message || 'Не удалось получить сертификаты КриптоПро');
    } finally {
      setCertsLoading(false);
    }
  };

  const toggleGroup = (id) => {
    setProductGroups((prev) => (
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    ));
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!selectedOrgId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload = {
        sandbox,
        api_version: apiVersion,
        united_token: unitedToken,
        inn: resolvedInn,
        product_groups: productGroups,
        operations,
        cert_thumbprint: thumbprint,
        oms_id: omsId,
        oms_connection: omsConnection,
      };
      if (manualToken.trim()) payload.token = manualToken.trim();
      if (omsToken.trim()) payload.oms_token = omsToken.trim();
      const data = await chestnyZnakApi.saveConfig(payload);
      applyConfig(data);
      setNotice('Настройки сохранены');
      invalidateChestnyZnakEnabled();
      if (onConfigChange) onConfigChange();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Не удалось сохранить настройки'));
    } finally {
      setSaving(false);
    }
  };

  const handleSignIn = async () => {
    if (!selectedOrgId) return;
    if (!thumbprint) {
      setError('Выберите сертификат УКЭП');
      return;
    }
    setSigning(true);
    setError(null);
    setNotice(null);
    try {
      await chestnyZnakApi.saveConfig({
        sandbox,
        api_version: apiVersion,
        united_token: unitedToken,
        inn: resolvedInn,
        product_groups: productGroups,
        operations,
        cert_thumbprint: thumbprint,
      });
      const key = await chestnyZnakApi.fetchAuthKey();
      const signature = await createAttachedCadesBes(thumbprint, key.data);
      const data = await chestnyZnakApi.signIn({
        uuid: key.uuid,
        signature,
        inn: resolvedInn,
        unitedToken,
        cert_thumbprint: thumbprint,
      });
      applyConfig(data);
      setNotice('Вход в Честный знак выполнен');
      invalidateChestnyZnakEnabled();
      if (onConfigChange) onConfigChange();
    } catch (err) {
      setError(getApiErrorMessage(err, err?.message || 'Не удалось войти по УКЭП'));
    } finally {
      setSigning(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    setNotice(null);
    try {
      const data = await chestnyZnakApi.test();
      setNotice(data?.message || 'Подключение установлено');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Проверка подключения не удалась'));
    } finally {
      setTesting(false);
    }
  };

  const handleCheckCises = async () => {
    setCisChecking(true);
    setError(null);
    try {
      const data = await chestnyZnakApi.checkCises(cisText);
      setCisItems(data?.items || []);
    } catch (err) {
      setCisItems(null);
      setError(getApiErrorMessage(err, 'Не удалось проверить коды маркировки'));
    } finally {
      setCisChecking(false);
    }
  };

  const sessionOk = Boolean(config?.token_set) && !isExpired(config?.token_expires_at);

  if (!selectedOrgId) {
    return (
      <div className="chestny-tab">
        <div className="field" style={{ marginBottom: 16 }}>
          <label className="label">Организация</label>
          <select
            className="input"
            value=""
            onChange={(e) => onSelectOrg(e.target.value ? String(e.target.value) : null)}
          >
            <option value="">— Выберите организацию —</option>
            {(organizations || []).map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}{isValidInn(org.inn) ? ` — ${innDigits(org.inn)}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div style={{
          padding: 24,
          textAlign: 'center',
          color: 'var(--muted)',
          background: 'var(--card)',
          borderRadius: 8,
          border: '1px dashed var(--border)',
        }}
        >
          Выберите организацию: интеграция привязана к ИНН участника оборота в ГИС МТ.
        </div>
      </div>
    );
  }

  return (
    <div className="chestny-tab">
      <div className="field" style={{ marginBottom: 16 }}>
        <label className="label">Организация</label>
        <select
          className="input"
          value={selectedOrgId || ''}
          onChange={(e) => onSelectOrg(e.target.value ? String(e.target.value) : null)}
        >
          <option value="">— Выберите организацию —</option>
          {(organizations || []).map((org) => (
            <option key={org.id} value={org.id}>
              {org.name}{isValidInn(org.inn) ? ` — ${innDigits(org.inn)}` : ''}
            </option>
          ))}
        </select>
        {!isValidInn(selectedOrg?.inn) && (
          <small className="chestny-hint">
            У этой организации нет ИНН. Укажите его в карточке организации или выберите ИНН другой организации ниже.
          </small>
        )}
      </div>

      {error && <div className="error" style={{ marginBottom: 16 }}>{error}</div>}
      {notice && <div className="chestny-notice">{notice}</div>}

      {loading ? (
        <div className="loading" style={{ padding: 24 }}>Загрузка настроек…</div>
      ) : (
        <form onSubmit={handleSave} className="integration-form chestny-form">
          <div className={`chestny-session ${sessionOk ? 'is-ok' : ''}`}>
            <strong>{sessionOk ? 'Сессия True API активна' : 'Нет активной сессии'}</strong>
            <div className="chestny-hint">
              {config?.token_set
                ? `Токен ${config.token_preview || 'сохранён'}${config.token_expires_at ? `, до ${formatExpiry(config.token_expires_at)}` : ''}`
                : 'Войдите по УКЭП (КриптоПро) или вставьте токен, полученный в другом инструменте.'}
            </div>
          </div>

          <label className="chestny-check">
            <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} />
            Демо-контур (sandbox)
          </label>

          <div className="chestny-row">
            <div className="field">
              <label className="label">Версия True API</label>
              <select className="input" value={apiVersion} onChange={(e) => setApiVersion(e.target.value)}>
                <option value="v3">v3</option>
                <option value="v4">v4</option>
              </select>
            </div>
            <div className="field">
              <label className="label">ИНН участника</label>
              <select
                className="input"
                value={resolvedInn}
                onChange={(e) => setInn(e.target.value)}
              >
                <option value="">— Выберите организацию —</option>
                {innOptions.map((o) => (
                  <option key={o.inn} value={o.inn}>
                    {o.name} — {o.inn}
                  </option>
                ))}
                {resolvedInn && !innOptions.some((o) => o.inn === resolvedInn) && (
                  <option value={resolvedInn}>{resolvedInn}</option>
                )}
              </select>
              {innOptions.length === 0 && (
                <small className="chestny-hint">
                  Нет организаций с ИНН. Добавьте ИНН в разделе «Организации».
                </small>
              )}
            </div>
          </div>

          <label className="chestny-check">
            <input
              type="checkbox"
              checked={unitedToken}
              onChange={(e) => setUnitedToken(e.target.checked)}
            />
            Запрашивать единый токен (UUID). По умолчанию JWT — он поддерживается до осени 2026.
          </label>

          <div className="field">
            <label className="label">Товарные группы</label>
            <input
              type="search"
              className="input"
              value={groupQuery}
              onChange={(e) => setGroupQuery(e.target.value)}
              placeholder="Найти группу (масла, шины, химия…)"
            />
            <div className="chestny-groups">
              {visibleGroupOptions.map((g) => (
                <label key={g.id} className="chestny-check">
                  <input
                    type="checkbox"
                    checked={productGroups.includes(g.id)}
                    onChange={() => toggleGroup(g.id)}
                  />
                  {g.name}
                </label>
              ))}
              {visibleGroupOptions.length === 0 && (
                <span className="chestny-hint">Ничего не найдено</span>
              )}
            </div>
            <small className="chestny-hint">
              Выбрано {productGroups.length} из {groupOptions.length}. Отметьте группы, подключённые в ЛК Честного знака.
            </small>
          </div>

          <div className="field">
            <label className="label">Схемы работы этой организации</label>
            <p className="chestny-hint">
              У каждой организации свой кабинет и свои схемы. Выключите то, чем эта фирма не пользуется.
            </p>
            <div className="chestny-groups">
              {(config?.operationOptions?.length ? config.operationOptions : CHESTNY_ZNAK_OPERATIONS).map((op) => (
                <label key={op.id} className="chestny-check">
                  <input
                    type="checkbox"
                    checked={operations[op.id] !== false}
                    onChange={() => setOperations((prev) => ({ ...prev, [op.id]: prev[op.id] === false }))}
                  />
                  <span>
                    <strong>{op.name}</strong>
                    {op.hint ? <span className="chestny-hint">{op.hint}</span> : null}
                  </span>
                </label>
              ))}
            </div>
            {config?.configured ? (
              <p className="chestny-hint" style={{ marginTop: 8 }}>
                <Link to="/stock-levels/marking">Открыть журнал КИ и документы →</Link>
              </p>
            ) : null}
          </div>

          <div className="chestny-block">
            <ChestnyZnakSetupChecklist
              setup={setup}
              checking={setupChecking}
              onCheck={runSetupCheck}
              pluginOk={pluginOk}
            />
            <h3>Вход по УКЭП</h3>
            <div className="form-actions" style={{ marginTop: 8 }}>
              <Button type="button" variant="secondary" onClick={loadCerts} disabled={certsLoading}>
                {certsLoading ? 'Чтение сертификатов…' : 'Показать сертификаты'}
              </Button>
            </div>
            {certs.length > 0 && (
              <div className="field" style={{ marginTop: 12 }}>
                <label className="label">Сертификат</label>
                <select
                  className="input"
                  value={thumbprint}
                  onChange={(e) => setThumbprint(e.target.value)}
                >
                  <option value="">— Выберите —</option>
                  {certs.map((c) => (
                    <option key={c.thumbprint} value={c.thumbprint} disabled={c.expired}>
                      {c.name}{c.expired ? ' (истёк)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="form-actions">
              <Button type="button" variant="primary" onClick={handleSignIn} disabled={signing || !thumbprint || !isValidInn(resolvedInn)}>
                {signing ? 'Подпись и вход…' : 'Войти по УКЭП'}
              </Button>
              <Button type="button" variant="secondary" onClick={handleTest} disabled={testing || !config?.token_set}>
                {testing ? 'Проверка…' : 'Проверить подключение'}
              </Button>
            </div>
          </div>

          <div className="field">
            <label className="label">Токен сессии (если уже есть)</label>
            <textarea
              className="input chestny-token"
              rows={3}
              value={manualToken}
              onChange={(e) => setManualToken(e.target.value)}
              placeholder={config?.token_set ? `Сохранён ${config.token_preview}` : 'Вставьте JWT / UUID-токен True API'}
              autoComplete="off"
            />
          </div>

          <button
            type="button"
            className="chestny-oms-toggle"
            onClick={() => setOmsOpen((v) => !v)}
          >
            {omsOpen ? '▾' : '▸'} СУЗ (заказ кодов маркировки) — для производителей и импортёров
          </button>
          {omsOpen && (
            <div className="chestny-block">
              <div className="field">
                <label className="label">OMS ID</label>
                <input className="input" value={omsId} onChange={(e) => setOmsId(e.target.value)} />
              </div>
              <div className="field">
                <label className="label">OMS Connection</label>
                <input className="input" value={omsConnection} onChange={(e) => setOmsConnection(e.target.value)} />
              </div>
              <div className="field">
                <label className="label">Client token СУЗ</label>
                <input
                  className="input"
                  type="password"
                  value={omsToken}
                  onChange={(e) => setOmsToken(e.target.value)}
                  placeholder={config?.oms_token_set ? 'Токен сохранён' : ''}
                  autoComplete="off"
                />
              </div>
              <p className="chestny-hint">Поля сохраняются. Обмен с СУЗ подключим следующим шагом.</p>
            </div>
          )}

          <div className="form-actions">
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Сохранение…' : 'Сохранить настройки'}
            </Button>
          </div>
        </form>
      )}

      <div className="chestny-block chestny-cis">
        <h3>Проверка кодов маркировки</h3>
        <p className="chestny-hint">
          Вставьте КИ / Data Matrix (по одному в строке). Нужна активная сессия True API.
        </p>
        <textarea
          className="input chestny-token"
          rows={5}
          value={cisText}
          onChange={(e) => setCisText(e.target.value)}
          placeholder={'0104600…\n0104600…'}
        />
        <div className="form-actions">
          <Button type="button" variant="secondary" onClick={handleCheckCises} disabled={cisChecking || !cisText.trim()}>
            {cisChecking ? 'Проверка…' : 'Проверить коды'}
          </Button>
        </div>
        {Array.isArray(cisItems) && (
          cisItems.length === 0 ? (
            <p className="chestny-hint">Честный знак не вернул данные по этим кодам.</p>
          ) : (
            <div className="chestny-cis-table-wrap">
              <table className="chestny-cis-table">
                <thead>
                  <tr>
                    <th>КИ</th>
                    <th>Статус</th>
                    <th>GTIN</th>
                    <th>Владелец</th>
                    <th>Комментарий</th>
                  </tr>
                </thead>
                <tbody>
                  {cisItems.map((row, idx) => (
                    <tr key={`${row.cis || 'row'}-${idx}`}>
                      <td className="chestny-mono">{row.cis}</td>
                      <td>{row.status_label || row.status || '—'}</td>
                      <td className="chestny-mono">{row.gtin || '—'}</td>
                      <td>{row.owner_inn || '—'}</td>
                      <td>{row.ok ? (row.product_name || row.product_group || '') : (row.error_message || 'Ошибка')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </div>
  );
}
