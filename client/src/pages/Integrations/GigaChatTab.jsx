import React, { useEffect, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { useAuth } from '../../context/AuthContext';
import { aiApi } from '../../services/ai.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';

const MODELS = [
  { id: 'GigaChat-2', label: 'GigaChat 2 Lite — дешевле, для простых вопросов' },
  { id: 'GigaChat-2-Pro', label: 'GigaChat 2 Pro' },
  { id: 'GigaChat-2-Max', label: 'GigaChat 2 Max — лучше для аналитики (рекомендуется)' },
  { id: 'GigaChat-3-Ultra', label: 'GigaChat 3 Ultra' },
];

const SCOPES = [
  { id: 'GIGACHAT_API_PERS', label: 'PERS — физлицо / Freemium' },
  { id: 'GIGACHAT_API_B2B', label: 'B2B — ИП и юрлица, предоплата' },
  { id: 'GIGACHAT_API_CORP', label: 'CORP — ИП и юрлица, постоплата' },
];

const API_BASES = [
  { id: 'https://api.giga.chat/v1', label: 'https://api.giga.chat/v1' },
  { id: 'https://gigachat.devices.sberbank.ru/api/v1', label: 'https://gigachat.devices.sberbank.ru/api/v1 (старый)' },
];

export function GigaChatTab({ onConfigChange }) {
  const { isAccountAdmin, isProfileAdmin, isAdmin } = useAuth();
  const canEdit = !!(isAccountAdmin || isProfileAdmin || isAdmin);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const [credentials, setCredentials] = useState('');
  const [credentialsSet, setCredentialsSet] = useState(false);
  const [scope, setScope] = useState('GIGACHAT_API_PERS');
  const [model, setModel] = useState('GigaChat-2-Max');
  const [apiBase, setApiBase] = useState('https://api.giga.chat/v1');
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await aiApi.getConfig();
        if (cancelled) return;
        setCredentialsSet(!!data?.credentialsSet);
        setScope(data?.scope || 'GIGACHAT_API_PERS');
        setModel(data?.model || 'GigaChat-2-Max');
        setApiBase(data?.apiBase || 'https://api.giga.chat/v1');
        setEnabled(data?.enabled !== false);
        setCredentials('');
      } catch (err) {
        if (!cancelled) setError(getApiErrorMessage(err, 'Не удалось загрузить настройки GigaChat'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async (e) => {
    e.preventDefault();
    try {
      setSaving(true);
      setError(null);
      setNotice(null);
      const payload = { scope, model, apiBase, enabled };
      const cred = String(credentials || '').trim();
      if (cred && cred !== '********') payload.credentials = cred;
      const data = await aiApi.saveConfig(payload);
      setCredentialsSet(!!data?.credentialsSet);
      setCredentials('');
      setNotice('Настройки сохранены.');
      onConfigChange?.();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Не удалось сохранить настройки'));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    try {
      setTesting(true);
      setError(null);
      setNotice(null);
      const cred = String(credentials || '').trim();
      if (cred && cred !== '********') {
        const data = await aiApi.saveConfig({ scope, model, apiBase, enabled, credentials: cred });
        setCredentialsSet(!!data?.credentialsSet);
        setCredentials('');
        onConfigChange?.();
      }
      const data = await aiApi.test();
      setNotice(data?.message || 'Подключение успешно.');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Проверка не удалась'));
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return <p className="chestny-hint">Загрузка настроек…</p>;
  }

  return (
    <div className="chestny-tab">
      <form className="chestny-form" onSubmit={handleSave}>
        <p className="chestny-hint" style={{ marginTop: 0 }}>
          Ключ на аккаунт, не на организацию. Создайте проект в{' '}
          <a href="https://developers.sber.ru/studio/" target="_blank" rel="noopener noreferrer">
            GigaChat Developers Studio
          </a>
          , скопируйте Authorization key. Для пробы подойдёт Freemium (физлицо, scope PERS) и модель Max.
          Ключ хранится на сервере и в браузер больше не отдаётся.
        </p>

        {error && <div className="error" style={{ marginBottom: 16 }}>{error}</div>}
        {notice && <div className="chestny-notice">{notice}</div>}

        <div className="field">
          <label className="label">Ключ авторизации</label>
          <input
            type="password"
            className="input"
            autoComplete="off"
            value={credentials}
            onChange={(e) => setCredentials(e.target.value)}
            placeholder={credentialsSet ? 'Сохранён, введите новый чтобы заменить' : 'Вставьте ключ из Studio'}
            disabled={!canEdit}
          />
          {credentialsSet && (
            <small className="chestny-hint">Ключ уже сохранён. Поле можно оставить пустым.</small>
          )}
        </div>

        <div className="field">
          <label className="label">Scope</label>
          <select className="input" value={scope} onChange={(e) => setScope(e.target.value)} disabled={!canEdit}>
            {SCOPES.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="label">Модель</label>
          <select className="input" value={model} onChange={(e) => setModel(e.target.value)} disabled={!canEdit}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="label">Адрес API</label>
          <select className="input" value={apiBase} onChange={(e) => setApiBase(e.target.value)} disabled={!canEdit}>
            {API_BASES.map((b) => (
              <option key={b.id} value={b.id}>{b.label}</option>
            ))}
          </select>
        </div>

        <label className="chestny-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={!canEdit}
          />
          Включить ассистента в аналитике
        </label>

        {canEdit ? (
          <div className="form-actions">
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Сохранение…' : 'Сохранить'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={handleTest}
              disabled={testing || saving || !(credentialsSet || String(credentials).trim())}
            >
              {testing ? 'Проверка…' : 'Проверить подключение'}
            </Button>
          </div>
        ) : (
          <p className="chestny-hint">Менять ключ может администратор аккаунта.</p>
        )}
      </form>
    </div>
  );
}
