/**
 * Settings Page
 * Страница настроек приложения
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import { profilesApi } from '../../services/profiles.api.js';
import { accountSettingsFromProfile, isProfileBoolFlag } from '../../utils/profileFlags.js';
import { Button } from '../../components/common/Button/Button';
import {
  BUILTIN_SOUNDS,
  SOUND_EVENTS,
  loadSoundSettings,
  saveSoundSettings,
  playEventSound,
  readAudioFileAsDataUrl,
} from '../../utils/soundSettings';
import './Settings.css';

export function Settings() {
  const { isProfileAdmin, profileId, refreshUser } = useAuth();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resettingAllStock, setResettingAllStock] = useState(false);
  const [resetAllStockMessage, setResetAllStockMessage] = useState('');
  const [error, setError] = useState('');
  const [soundForm, setSoundForm] = useState(loadSoundSettings);
  const [soundError, setSoundError] = useState('');
  const [form, setForm] = useState({
    name: '',
    contact_email: '',
    contact_phone: '',
    allow_private_orders: false,
    require_reserved_stock_for_assembly: false,
    allow_manual_warehouse_stock_edit: false,
    allow_stock_history_reset: false,
    procurement_status_enabled: true,
  });

  const loadAccount = useCallback(async () => {
    if (!isProfileAdmin || profileId == null) return;
    setLoading(true);
    setError('');
    try {
      const res = await profilesApi.getMe();
      const nextForm = accountSettingsFromProfile(res?.data);
      if (nextForm) setForm(nextForm);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось загрузить данные аккаунта');
    } finally {
      setLoading(false);
    }
  }, [isProfileAdmin, profileId]);

  useEffect(() => {
    loadAccount();
  }, [loadAccount]);

  const saveAccount = async () => {
    const name = form.name.trim();
    if (!name) {
      alert('Укажите название аккаунта');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = {
        name,
        contact_email: form.contact_email.trim() || null,
        contact_phone: form.contact_phone.trim() || null,
        allow_private_orders: form.allow_private_orders,
        require_reserved_stock_for_assembly: form.require_reserved_stock_for_assembly,
        allow_manual_warehouse_stock_edit: form.allow_manual_warehouse_stock_edit,
        allow_stock_history_reset: form.allow_stock_history_reset,
        procurement_status_enabled: form.procurement_status_enabled,
      };
      const res = await profilesApi.updateMe(payload);
      if (!res?.ok) {
        throw new Error(res?.message || 'Ошибка сохранения');
      }
      const saved = accountSettingsFromProfile(res.data);
      if (saved) setForm(saved);
      await refreshUser();

      const flagChecks = [
        ['allow_manual_warehouse_stock_edit', 'ручное изменение наличия на складе'],
        ['allow_stock_history_reset', 'сброс истории остатков'],
      ];
      const notSaved = flagChecks
        .filter(([key]) => !!payload[key] !== !!saved?.[key])
        .map(([, label]) => label);
      if (notSaved.length > 0) {
        setError(
          `Не удалось сохранить настройки: ${notSaved.join(', ')}. Перезапустите API-сервер (node server.js) и сохраните снова.`
        );
        return;
      }
      alert('Сохранено');
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const resetAllStockHistory = async () => {
    if (!isProfileBoolFlag(form.allow_stock_history_reset)) return;
    const confirmed = window.confirm(
      'Будет удалена вся история движений остатков по всем товарам аккаунта (кроме комплектов).\n\n' +
        'Текущие значения «В пути», «Наличие», «Резерв» и «Доступно» останутся без изменений.\n\n' +
        'Операция необратима. Продолжить?'
    );
    if (!confirmed) return;

    setResettingAllStock(true);
    setResetAllStockMessage('');
    setError('');
    try {
      const res = await profilesApi.resetAllStockHistory();
      if (!res?.ok) {
        throw new Error(res?.message || 'Не удалось выполнить сброс');
      }
      const data = res.data || {};
      const processed = Number(data.productsProcessed) || 0;
      const total = Number(data.productsTotal) || 0;
      const errors = Array.isArray(data.errors) ? data.errors : [];
      if (errors.length > 0) {
        setResetAllStockMessage(
          `Обработано ${processed} из ${total} товаров. Ошибки: ${errors.length}. Подробности в консоли.`
        );
        console.warn('[Settings] stock history reset errors:', errors);
      } else {
        setResetAllStockMessage(`Готово: история остатков сброшена для ${processed} товаров.`);
      }
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка массового сброса истории остатков');
    } finally {
      setResettingAllStock(false);
    }
  };

  return (
    <div className="settings-page card">
      <h1 className="title">Настройки</h1>
      <p className="subtitle">Общие настройки системы.</p>

      <section className="settings-account-section" style={{ marginBottom: 18 }}>
        <h2 className="h5">Звуки</h2>
        <p className="text-muted small mb-3">
          Включите короткие звуки для событий в интерфейсе. Настройки сохраняются в этом браузере (на этом ПК).
        </p>
        {soundError && <p className="text-danger">{soundError}</p>}

        <label className="settings-account-toggle" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={soundForm?.enabled !== false}
            onChange={(e) => {
              const on = e.target.checked;
              setSoundForm((prev) => {
                const next = { ...(prev || {}) };
                next.enabled = on;
                saveSoundSettings(next);
                return next;
              });
            }}
          />
          <span>
            <strong>Включить звуковые уведомления</strong>
            <span className="text-muted small" style={{ display: 'block', fontWeight: 'normal', marginTop: 4 }}>
              Можно отключить звуки полностью для этого пользователя/ПК.
            </span>
          </span>
        </label>

        {[
          { key: SOUND_EVENTS.scan_ok, title: 'Правильное сканирование', hint: 'Когда скан прошёл и товар/заказ найден.' },
          { key: SOUND_EVENTS.scan_error, title: 'Ошибка сканирования', hint: 'Когда скан прошёл, но ничего не найдено.' },
          { key: SOUND_EVENTS.new_order, title: 'Новый заказ', hint: 'Когда появляется новый заказ (автообновление списка).' },
        ].map(({ key, title, hint }) => {
          const sel = soundForm?.[key] || { kind: 'builtin', id: 'beep_1' };
          const v =
            sel.kind === 'none' ? 'none' : sel.kind === 'custom' ? 'custom' : `builtin:${sel.id || 'beep_1'}`;
          const customRec = soundForm?.custom?.[key];
          const customName = typeof customRec === 'string' ? '' : (customRec?.name || '');
          return (
            <div key={key} className="settings-account-form" style={{ marginBottom: 12 }}>
              <label className="settings-account-label" style={{ marginBottom: 8 }}>
                {title}
                <span className="text-muted small" style={{ display: 'block', fontWeight: 'normal', marginTop: 4 }}>
                  {hint}
                </span>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                  <select
                    className="login-input"
                    style={{ maxWidth: 360 }}
                    value={v}
                    disabled={soundForm?.enabled === false}
                    onChange={(e) => {
                      const nextVal = e.target.value;
                      setSoundError('');
                      setSoundForm((prev) => {
                        const cur = { ...(prev || {}) };
                        if (nextVal === 'none') cur[key] = { kind: 'none' };
                        else if (nextVal === 'custom') cur[key] = { kind: 'custom' };
                        else if (nextVal.startsWith('builtin:')) cur[key] = { kind: 'builtin', id: nextVal.slice('builtin:'.length) };
                        saveSoundSettings(cur);
                        return cur;
                      });
                    }}
                  >
                    <option value="none">Без звука</option>
                    {BUILTIN_SOUNDS.map((s) => (
                      <option key={s.id} value={`builtin:${s.id}`}>
                        {s.label}
                      </option>
                    ))}
                    <option value="custom">Свой файл…</option>
                  </select>
                  <Button type="button" variant="outline-secondary" onClick={() => playEventSound(key)} disabled={soundForm?.enabled === false}>
                    Прослушать
                  </Button>
                </div>
              </label>

              {((soundForm?.[key] || {}).kind === 'custom') && (
                <label className="settings-account-label" style={{ marginTop: 6 }}>
                  Файл (mp3/wav/ogg)
                  {customName && (
                    <span className="text-muted small" style={{ display: 'block', fontWeight: 'normal', marginTop: 4 }}>
                      Загружено: <strong>{customName}</strong>
                    </span>
                  )}
                  <input
                    type="file"
                    accept="audio/*"
                    className="login-input"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      try {
                        setSoundError('');
                        const dataUrl = await readAudioFileAsDataUrl(file);
                        setSoundForm((prev) => {
                          const next = { ...(prev || {}) };
                          next.custom = { ...(next.custom || {}) };
                          next.custom[key] = { dataUrl, name: file.name || 'загруженный файл' };
                          next[key] = { kind: 'custom' };
                          saveSoundSettings(next);
                          return next;
                        });
                      } catch (err) {
                        setSoundError(err?.message || 'Не удалось загрузить звук');
                      } finally {
                        // allow re-upload same file
                        e.target.value = '';
                      }
                    }}
                  />
                  <div style={{ marginTop: 8 }}>
                    <Button
                      type="button"
                      variant="outline-secondary"
                      onClick={() => {
                        setSoundForm((prev) => {
                          const next = { ...(prev || {}) };
                          next.custom = { ...(next.custom || {}) };
                          next.custom[key] = null;
                          saveSoundSettings(next);
                          return next;
                        });
                      }}
                    >
                      Удалить загруженный звук
                    </Button>
                  </div>
                </label>
              )}
            </div>
          );
        })}
      </section>

      {isProfileAdmin && profileId != null && (
        <section className="settings-account-section">
          <h2 className="h5">Аккаунт</h2>
          <p className="text-muted small mb-3">
            Название аккаунта, контактная почта и телефон (для связи по аккаунту; не меняет email входа в систему).
          </p>
          {loading && <p className="text-muted">Загрузка...</p>}
          {error && <p className="text-danger">{error}</p>}
          {!loading && (
            <div className="settings-account-form">
              <label className="settings-account-label">
                Название аккаунта
                <input
                  type="text"
                  className="login-input"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  autoComplete="organization"
                />
              </label>
              <label className="settings-account-label">
                Контактный email
                <input
                  type="email"
                  className="login-input"
                  value={form.contact_email}
                  onChange={(e) => setForm((f) => ({ ...f, contact_email: e.target.value }))}
                  autoComplete="email"
                />
              </label>
              <label className="settings-account-label">
                Контактный телефон
                <input
                  type="tel"
                  className="login-input"
                  value={form.contact_phone}
                  onChange={(e) => setForm((f) => ({ ...f, contact_phone: e.target.value }))}
                  autoComplete="tel"
                />
              </label>
              <label className="settings-account-toggle" style={{ marginTop: 10 }}>
                <input
                  type="checkbox"
                  checked={form.procurement_status_enabled !== false}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, procurement_status_enabled: e.target.checked }))
                  }
                />
                <span>
                  <strong>Статус заказа «В закупке»</strong>
                  <span className="text-muted small" style={{ display: 'block', fontWeight: 'normal', marginTop: 4 }}>
                    Если выключено — заказы не переводятся в «В закупке» (вручную, при закупке и автозаказе).
                    Резерв с наличия и «в пути» по-прежнему создаётся для заказов в статусе «Новый».
                  </span>
                </span>
              </label>
              <label className="settings-account-toggle">
                <input
                  type="checkbox"
                  checked={form.require_reserved_stock_for_assembly === true}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, require_reserved_stock_for_assembly: e.target.checked }))
                  }
                />
                <span>
                  <strong>Запрет «На сборку» без фактического резерва</strong>
                  <span className="text-muted small" style={{ display: 'block', fontWeight: 'normal', marginTop: 4 }}>
                    Если включено — заказ нельзя отправить «На сборку», пока под него не создан резерв товара и он покрыт фактическим остатком на складе.
                  </span>
                </span>
              </label>
              <label className="settings-account-toggle">
                <input
                  type="checkbox"
                  checked={form.allow_private_orders}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, allow_private_orders: e.target.checked }))
                  }
                />
                <span>
                  <strong>Выполнять частные заказы</strong>
                  <span className="text-muted small" style={{ display: 'block', fontWeight: 'normal', marginTop: 4 }}>
                    Разрешить создание заказов вручную и фильтр «Ручной» в списке заказов. При выключении частные заказы
                    не отображаются в списке.
                  </span>
                </span>
              </label>
              <label className="settings-account-toggle">
                <input
                  type="checkbox"
                  checked={isProfileBoolFlag(form.allow_manual_warehouse_stock_edit)}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, allow_manual_warehouse_stock_edit: e.target.checked }))
                  }
                />
                <span>
                  <strong>Ручное изменение наличия на складе</strong>
                  <span className="text-muted small" style={{ display: 'block', fontWeight: 'normal', marginTop: 4 }}>
                    В списке остатков можно вручную задать количество «Наличие» и сохранить галочкой. При выключении
                    остаток меняется только приёмкой, списанием, отгрузкой, инвентаризацией и другими документами.
                  </span>
                </span>
              </label>
              <label className="settings-account-toggle">
                <input
                  type="checkbox"
                  checked={isProfileBoolFlag(form.allow_stock_history_reset)}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, allow_stock_history_reset: e.target.checked }))
                  }
                />
                <span>
                  <strong>Сброс истории остатков по товару</strong>
                  <span className="text-muted small" style={{ display: 'block', fontWeight: 'normal', marginTop: 4 }}>
                    В таблице остатков можно очистить историю по одному товару. В настройках аккаунта появится
                    кнопка массового сброса по всем товарам. При выключении функции кнопки скрыты.
                  </span>
                </span>
              </label>
              {isProfileBoolFlag(form.allow_stock_history_reset) && (
                <div className="settings-stock-reset-all">
                  <p className="text-muted small" style={{ marginBottom: 8 }}>
                    Удалить всю историю движений остатков по всем товарам аккаунта. Текущие «В пути», «Наличие»,
                    «Резерв» и «Доступно» сохранятся как начальные значения без прошлых записей журнала.
                  </p>
                  {resetAllStockMessage && (
                    <p className="text-success small" style={{ marginBottom: 8 }}>
                      {resetAllStockMessage}
                    </p>
                  )}
                  <Button
                    type="button"
                    variant="danger"
                    onClick={resetAllStockHistory}
                    disabled={resettingAllStock || saving}
                  >
                    {resettingAllStock ? 'Сброс истории…' : 'Обнулить все движения остатков'}
                  </Button>
                </div>
              )}
              <div className="settings-account-actions">
                <Button type="button" variant="primary" onClick={saveAccount} disabled={saving}>
                  {saving ? 'Сохранение…' : 'Сохранить'}
                </Button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
