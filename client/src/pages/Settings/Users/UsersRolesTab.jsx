/**
 * Вкладка «Роли» в разделе Пользователи.
 */

import React, { useState, useEffect, useCallback } from 'react';
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
  const [navSections, setNavSections] = useState(defaultNavSectionsAllEnabled);
  const [configured, setConfigured] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await profilesApi.getRoleNavSections();
      const roles = res?.data?.roles ?? {};
      setRolesData(roles);
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
    const row = rolesData[activeRole];
    if (row) {
      setNavSections(row.navSections || defaultNavSectionsAllEnabled());
      setConfigured(!!row.configured);
    } else {
      setNavSections(navSectionsToFormState(ROLE_NAV_PRESETS[activeRole] || {}));
      setConfigured(false);
    }
  }, [activeRole, rolesData]);

  const setNavSection = (key, enabled) => {
    setNavSections((prev) => ({ ...prev, [key]: enabled }));
  };

  const applyDefaultPreset = () => {
    setNavSections(navSectionsToFormState(ROLE_NAV_PRESETS[activeRole] || {}));
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await profilesApi.updateRoleNavSection(activeRole, { navSections });
      const data = res?.data;
      setRolesData((prev) => ({
        ...prev,
        [activeRole]: {
          configured: data?.configured ?? true,
          navSections: data?.navSections ?? navSections,
        },
      }));
      setConfigured(true);
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
      setRolesData((prev) => ({
        ...prev,
        [activeRole]: {
          configured: false,
          navSections: data?.navSections ?? navSectionsToFormState(ROLE_NAV_PRESETS[activeRole] || {}),
        },
      }));
      setConfigured(false);
      setNavSections(data?.navSections ?? navSectionsToFormState(ROLE_NAV_PRESETS[activeRole] || {}));
      alert('Восстановлены стандартные настройки роли');
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка сброса');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="settings-users-loading">Загрузка...</div>;

  return (
    <>
      <p className="text-muted small" style={{ marginBottom: '1rem', lineHeight: 1.4 }}>
        Настройте, какие разделы видны пользователям с выбранной ролью. Пользователю достаточно назначить роль на вкладке «Список».
        Администратор аккаунта всегда видит все разделы.
      </p>
      {error && <p className="text-danger">{error}</p>}

      <div className="settings-roles-tabs">
        {CONFIGURABLE_ACCOUNT_ROLES.map((role) => (
          <button
            key={role}
            type="button"
            className={`settings-roles-tab${activeRole === role ? ' settings-roles-tab--active' : ''}`}
            onClick={() => setActiveRole(role)}
          >
            {ACCOUNT_ROLE_LABELS[role]}
            {rolesData[role]?.configured ? <span className="settings-roles-tab-badge">свои</span> : null}
          </button>
        ))}
      </div>

      <div className="settings-users-nav-sections">
        <div className="settings-users-nav-header">
          <span className="settings-users-nav-title">
            Роль: {ACCOUNT_ROLE_LABELS[activeRole]}
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
          </div>
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
        <Button variant="primary" onClick={save} disabled={saving}>
          {saving ? 'Сохранение…' : 'Сохранить роль'}
        </Button>
      </div>
    </>
  );
}
