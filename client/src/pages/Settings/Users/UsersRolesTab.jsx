/**
 * Вкладка «Роли» в разделе Пользователи.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { profilesApi } from '../../../services/profiles.api.js';
import { Button } from '../../../components/common/Button/Button';
import {
  NAV_SECTION_GROUPS,
  NAV_SECTION_LABELS,
  CONFIGURABLE_ACCOUNT_ROLES,
  ACCOUNT_ROLE_LABELS,
  ROLE_NAV_PRESETS,
  defaultNavSectionsAllEnabled,
  navSectionsToFormState,
} from '../../../utils/userNavSections.js';

export function UsersRolesTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [activeRole, setActiveRole] = useState('picker');
  const [rolesData, setRolesData] = useState({});
  const [customRoles, setCustomRoles] = useState([]);
  const [navSections, setNavSections] = useState(() => defaultNavSectionsAllEnabled());
  const [dailyLogout, setDailyLogout] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newBase, setNewBase] = useState('editor');

  const roleTabs = useMemo(() => {
    const system = CONFIGURABLE_ACCOUNT_ROLES.map((key) => ({
      key,
      label: ACCOUNT_ROLE_LABELS[key] || key,
      system: true,
    }));
    const custom = customRoles.map((r) => ({
      key: r.key,
      label: r.label || r.key,
      system: false,
    }));
    return [...system, ...custom];
  }, [customRoles]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await profilesApi.getRoleNavSections();
      const roles = res?.data?.roles ?? {};
      setRolesData(roles);
      setCustomRoles(Array.isArray(res?.data?.customRoles) ? res.data.customRoles : []);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!roleTabs.some((r) => r.key === activeRole) && roleTabs[0]) {
      setActiveRole(roleTabs[0].key);
    }
  }, [roleTabs, activeRole]);

  useEffect(() => {
    const row = rolesData[activeRole];
    const custom = customRoles.find((r) => r.key === activeRole);
    const base = custom?.base || activeRole;
    if (row) {
      setNavSections(row.navSections || defaultNavSectionsAllEnabled());
      setDailyLogout(row.dailyLogout === true);
      setConfigured(!!row.configured);
    } else {
      setNavSections(navSectionsToFormState(ROLE_NAV_PRESETS[base] || ROLE_NAV_PRESETS.editor || {}));
      setDailyLogout(false);
      setConfigured(false);
    }
  }, [activeRole, rolesData, customRoles]);

  const setNavSection = (key, enabled) => {
    setNavSections((prev) => ({ ...prev, [key]: enabled }));
  };

  const applyDefaultPreset = () => {
    const custom = customRoles.find((r) => r.key === activeRole);
    const base = custom?.base || activeRole;
    setNavSections(navSectionsToFormState(ROLE_NAV_PRESETS[base] || ROLE_NAV_PRESETS.editor || {}));
    setDailyLogout(false);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await profilesApi.updateRoleNavSection(activeRole, { navSections, dailyLogout });
      const data = res?.data;
      setRolesData((prev) => ({
        ...prev,
        [activeRole]: {
          ...(prev[activeRole] || {}),
          configured: data?.configured ?? true,
          navSections: data?.navSections ?? navSections,
          dailyLogout: data?.dailyLogout === true,
          label: data?.label || prev[activeRole]?.label,
          system: data?.system,
          base: data?.base,
        },
      }));
      setConfigured(true);
      setDailyLogout(data?.dailyLogout === true);
      alert('Сохранено');
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const resetToSystemDefault = async () => {
    if (!window.confirm('Вернуть стандартные разделы для этой роли? Сохранённые настройки аккаунта будут удалены.')) {
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await profilesApi.updateRoleNavSection(activeRole, { useDefaultPreset: true });
      const data = res?.data;
      const custom = customRoles.find((r) => r.key === activeRole);
      const base = custom?.base || activeRole;
      setRolesData((prev) => ({
        ...prev,
        [activeRole]: {
          ...(prev[activeRole] || {}),
          configured: false,
          navSections: data?.navSections ?? navSectionsToFormState(ROLE_NAV_PRESETS[base] || {}),
          dailyLogout: false,
        },
      }));
      setConfigured(false);
      setDailyLogout(false);
      setNavSections(data?.navSections ?? navSectionsToFormState(ROLE_NAV_PRESETS[base] || {}));
      alert('Восстановлены стандартные настройки роли');
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка сброса');
    } finally {
      setSaving(false);
    }
  };

  const createRole = async () => {
    const label = String(newLabel || '').trim();
    if (!label) {
      setError('Укажите название роли');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await profilesApi.createCustomRole({ label, base: newBase });
      const data = res?.data;
      const key = data?.role;
      await load();
      if (key) setActiveRole(key);
      setAddOpen(false);
      setNewLabel('');
      setNewBase('editor');
      alert(key ? `Роль «${label}» создана` : 'Роль создана');
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось создать роль');
    } finally {
      setSaving(false);
    }
  };

  const saveOrCreate = async () => {
    if (addOpen) {
      await createRole();
      return;
    }
    await save();
  };

  const deleteRole = async () => {
    const tab = roleTabs.find((r) => r.key === activeRole);
    if (!tab || tab.system) return;
    if (!window.confirm(`Удалить роль «${tab.label}»?`)) return;
    setSaving(true);
    setError('');
    try {
      await profilesApi.deleteCustomRole(activeRole);
      setActiveRole('editor');
      await load();
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось удалить роль');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="settings-users-loading">Загрузка...</div>;

  const activeMeta = roleTabs.find((r) => r.key === activeRole);
  const activeCustom = customRoles.find((r) => r.key === activeRole);

  return (
    <>
      <p className="text-muted small" style={{ marginBottom: '1rem', lineHeight: 1.4 }}>
        Настройте, какие разделы видны пользователям с выбранной ролью. Можно добавить свои роли.
        Администратор аккаунта всегда видит все разделы.
      </p>
      {error && <p className="text-danger">{error}</p>}

      <div className="settings-roles-tabs">
        {roleTabs.map((role) => (
          <button
            key={role.key}
            type="button"
            className={`settings-roles-tab${activeRole === role.key ? ' settings-roles-tab--active' : ''}`}
            onClick={() => setActiveRole(role.key)}
          >
            {role.label}
            {rolesData[role.key]?.configured ? <span className="settings-roles-tab-badge">свои</span> : null}
          </button>
        ))}
        <button
          type="button"
          className="settings-roles-tab settings-roles-tab--add"
          onClick={() => setAddOpen((v) => !v)}
          disabled={saving}
        >
          + Роль
        </button>
      </div>

      {addOpen && (
        <div className="settings-users-nav-sections" style={{ marginBottom: '1rem' }}>
          <div className="settings-users-nav-group-title">Новая роль</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
            <label className="form-group" style={{ margin: 0, minWidth: 200, flex: 1 }}>
              <span className="form-label">Название</span>
              <input
                className="form-control"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    createRole();
                  }
                }}
                placeholder="Например, Менеджер продаж"
                disabled={saving}
                autoFocus
              />
            </label>
            <label className="form-group" style={{ margin: 0, minWidth: 220 }}>
              <span className="form-label">Шаблон прав</span>
              <select
                className="form-control"
                value={newBase}
                onChange={(e) => setNewBase(e.target.value)}
                disabled={saving}
              >
                {CONFIGURABLE_ACCOUNT_ROLES.map((key) => (
                  <option key={key} value={key}>
                    {ACCOUNT_ROLE_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="primary" size="small" type="button" onClick={createRole} disabled={saving}>
              Создать роль
            </Button>
            <Button
              variant="secondary"
              size="small"
              type="button"
              onClick={() => {
                setAddOpen(false);
                setNewLabel('');
                setError('');
              }}
              disabled={saving}
            >
              Отмена
            </Button>
          </div>
          <p className="text-muted small" style={{ marginTop: 8, marginBottom: 0 }}>
            Нажмите «Создать роль» — нижняя кнопка «Сохранить роль» тоже создаст роль, пока открыта эта форма.
          </p>
        </div>
      )}

      <div className="settings-users-nav-sections">
        <div className="settings-users-nav-header">
          <span className="settings-users-nav-title">
            Роль: {activeMeta?.label || activeRole}
            {activeCustom ? ` (на основе: ${ACCOUNT_ROLE_LABELS[activeCustom.base] || activeCustom.base})` : ''}
            {configured ? ' (настроено для аккаунта)' : ' (стандартные настройки)'}
          </span>
          <div className="settings-roles-actions">
            <Button variant="secondary" size="small" type="button" onClick={applyDefaultPreset} disabled={saving}>
              Подставить стандарт
            </Button>
            {configured && (
              <Button variant="secondary" size="small" type="button" onClick={resetToSystemDefault} disabled={saving}>
                Сбросить к стандарту
              </Button>
            )}
            {activeMeta && !activeMeta.system && (
              <Button variant="secondary" size="small" type="button" onClick={deleteRole} disabled={saving}>
                Удалить роль
              </Button>
            )}
          </div>
        </div>

        <div className="settings-users-nav-group" style={{ marginBottom: '1rem' }}>
          <div className="settings-users-nav-group-title">Сессия</div>
          <div className="settings-users-nav-toggles">
            <label className="settings-users-nav-toggle form-check form-switch">
              <input
                className="form-check-input"
                type="checkbox"
                role="switch"
                checked={dailyLogout}
                onChange={(e) => setDailyLogout(e.target.checked)}
                disabled={saving}
              />
              <span className="form-check-label">Выходить из аккаунта каждый новый день</span>
            </label>
          </div>
          <p className="text-muted small settings-users-nav-hint" style={{ marginTop: 6 }}>
            При включении сессия действует только в календарный день входа — на следующий день нужен повторный вход.
          </p>
        </div>

        <p className="text-muted small settings-users-nav-hint">
          Выключенный раздел скрывается в меню и недоступен по прямой ссылке.
        </p>
        {NAV_SECTION_GROUPS.map((group) => (
          <div key={group.title} className="settings-users-nav-group">
            <div className="settings-users-nav-group-title">{group.title}</div>
            <div className="settings-users-nav-toggles">
              {group.keys.map((key) => (
                <label key={key} className="settings-users-nav-toggle form-check form-switch">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    role="switch"
                    checked={navSections[key] !== false}
                    onChange={(e) => setNavSection(key, e.target.checked)}
                    disabled={saving}
                  />
                  <span className="form-check-label">{NAV_SECTION_LABELS[key] || key}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="settings-users-footer">
        <Button variant="primary" onClick={saveOrCreate} disabled={saving}>
          {saving ? 'Сохранение…' : addOpen ? 'Создать роль' : 'Сохранить роль'}
        </Button>
      </div>
    </>
  );
}
