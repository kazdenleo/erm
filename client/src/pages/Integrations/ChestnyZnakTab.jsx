import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { chestnyZnakApi } from '../../services/chestnyZnak.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import {
  createAttachedCadesBes,
  isCryptoProAvailable,
  listCryptoProCertificates,
} from '../../utils/cryptoProSign.js';

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
  const [manualToken, setManualToken] = useState('');
  const [omsOpen, setOmsOpen] = useState(false);
  const [omsId, setOmsId] = useState('');
  const [omsConnection, setOmsConnection] = useState('');
  const [omsToken, setOmsToken] = useState('');

  const [pluginOk, setPluginOk] = useState(null);
  const [certs, setCerts] = useState([]);
  const [certsLoading, setCertsLoading] = useState(false);
  const [thumbprint, setThumbprint] = useState('');
  const [signing, setSigning] = useState(false);
  const [testing, setTesting] = useState(false);

  const [cisText, setCisText] = useState('');
  const [cisChecking, setCisChecking] = useState(false);
  const [cisItems, setCisItems] = useState(null);

  const selectedOrg = useMemo(
    () => (organizations || []).find((o) => String(o.id) === String(selectedOrgId)) || null,
    [organizations, selectedOrgId]
  );

  const groupOptions = (config?.productGroupOptions && config.productGroupOptions.length)
    ? config.productGroupOptions
    : [
      { id: 'tires', name: 'Шины' },
      { id: 'shoes', name: 'Обувь' },
      { id: 'lp', name: 'Одежда (лёгпром)' },
    ];

  const applyConfig = useCallback((data) => {
    setConfig(data || {});
    setSandbox(Boolean(data?.sandbox));
    setApiVersion(data?.api_version === 'v4' ? 'v4' : 'v3');
    setUnitedToken(Boolean(data?.united_token));
    setInn(data?.inn || '');
    setProductGroups(Array.isArray(data?.product_groups) && data.product_groups.length
      ? data.product_groups
      : ['tires']);
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
    let cancelled = false;
    isCryptoProAvailable().then((ok) => {
      if (!cancelled) setPluginOk(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
        inn: inn || selectedOrg?.inn || '',
        product_groups: productGroups,
        cert_thumbprint: thumbprint,
        oms_id: omsId,
        oms_connection: omsConnection,
      };
      if (manualToken.trim()) payload.token = manualToken.trim();
      if (omsToken.trim()) payload.oms_token = omsToken.trim();
      const data = await chestnyZnakApi.saveConfig(payload);
      applyConfig(data);
      setNotice('Настройки сохранены');
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
        inn: inn || selectedOrg?.inn || '',
        product_groups: productGroups,
        cert_thumbprint: thumbprint,
      });
      const key = await chestnyZnakApi.fetchAuthKey();
      const signature = await createAttachedCadesBes(thumbprint, key.data);
      const data = await chestnyZnakApi.signIn({
        uuid: key.uuid,
        signature,
        inn: inn || selectedOrg?.inn || '',
        unitedToken,
        cert_thumbprint: thumbprint,
      });
      applyConfig(data);
      setNotice('Вход в Честный знак выполнен');
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
              <option key={org.id} value={org.id}>{org.name}</option>
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
            <option key={org.id} value={org.id}>{org.name}</option>
          ))}
        </select>
        {selectedOrg?.inn ? (
          <small className="chestny-hint">ИНН организации: {selectedOrg.inn}</small>
        ) : (
          <small className="chestny-hint">Укажите ИНН в карточке организации или ниже — он нужен для входа в ГИС МТ.</small>
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
              <label className="label">ИНН участника (если не из организации)</label>
              <input
                className="input"
                value={inn}
                onChange={(e) => setInn(e.target.value)}
                placeholder={selectedOrg?.inn || '10 или 12 цифр'}
                inputMode="numeric"
              />
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
            <div className="chestny-groups">
              {groupOptions.map((g) => (
                <label key={g.id} className="chestny-check">
                  <input
                    type="checkbox"
                    checked={productGroups.includes(g.id)}
                    onChange={() => toggleGroup(g.id)}
                  />
                  {g.name}
                </label>
              ))}
            </div>
          </div>

          <div className="chestny-block">
            <h3>Вход по УКЭП</h3>
            <p className="chestny-hint">
              Нужны КриптоПро CSP и «КриптоПро ЭЦП Browser plug-in». Сертификат должен быть зарегистрирован
              как API-пользователь в личном кабинете{' '}
              <a href="https://markirovka.crpt.ru/" target="_blank" rel="noopener noreferrer">markirovka.crpt.ru</a>.
            </p>
            {pluginOk === false && (
              <p className="chestny-hint">Плагин не обнаружен. Можно сохранить настройки и вставить токен вручную.</p>
            )}
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
              <Button type="button" variant="primary" onClick={handleSignIn} disabled={signing || !thumbprint}>
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
