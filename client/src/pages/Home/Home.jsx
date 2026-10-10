/**
 * Home Page
 * Главная страница приложения: настраиваемый набор виджетов (раскладка хранится у пользователя).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { PageTitle } from '../../components/layout/PageTitle/PageTitle';
import { useAuth } from '../../context/AuthContext.jsx';
import { usersApi } from '../../services/users.api.js';
import { isNavFeatureEnabled } from '../../utils/userNavSections.js';
import { isProfileFboEnabled } from '../../utils/profileFlags.js';
import { WIDGETS, defaultLayout, sizeColClass } from './widgets/widgetRegistry';
import { HomeWidgetsEditor } from './widgets/HomeWidgetsEditor';
import { errorMessage } from './widgets/widgetUtils';
import './Home.css';

export function Home() {
  const { isAccountAdmin, isAdmin, user, profileId, features, profile } = useAuth();
  const [items, setItems] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const admin = Boolean(isAccountAdmin || isAdmin);
  const fboEnabled = isProfileFboEnabled(profile);

  const canAccess = useCallback(
    (def) => {
      if (def.adminOnly && !admin) return false;
      if (def.requiresFbo && !fboEnabled) return false;
      if (admin || !def.sectionKey) return true;
      return isNavFeatureEnabled(features, def.sectionKey);
    },
    [admin, fboEnabled, features]
  );

  useEffect(() => {
    let alive = true;
    usersApi
      .getHomeWidgets()
      .then((d) => alive && setItems(Array.isArray(d?.items) ? d.items : defaultLayout()))
      .catch(() => alive && setItems(defaultLayout()));
    return () => {
      alive = false;
    };
  }, [user?.id]);

  const persist = useCallback(async (next) => {
    setItems(next);
    setSaving(true);
    setSaveError(null);
    try {
      await usersApi.saveHomeWidgets(next);
      return true;
    } catch (e) {
      setSaveError(errorMessage(e, 'Не удалось сохранить настройки главной'));
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const handleSave = async (next) => {
    if (await persist(next)) setEditorOpen(false);
  };

  const handleReset = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await usersApi.resetHomeWidgets();
      setItems(defaultLayout());
      setEditorOpen(false);
    } catch (e) {
      setSaveError(errorMessage(e, 'Не удалось сбросить настройки главной'));
    } finally {
      setSaving(false);
    }
  };

  const updateSettings = (uid, settings) => {
    persist((items || []).map((it) => (it.uid === uid ? { ...it, settings } : it)));
  };

  const removeWidget = (uid) => {
    persist((items || []).filter((it) => it.uid !== uid));
  };

  const visible = (items || []).filter((it) => WIDGETS[it.type] && canAccess(WIDGETS[it.type]));

  return (
    <div>
      <PageTitle
        iconClass="pe-7s-home"
        iconBgClass="bg-mean-fruit"
        title="Главная"
        subtitle="Сводка по заказам, продажам, складу и аналитике — набор виджетов настраивается"
        actions={(
          <Button
            className="btn-shadow"
            variant="info"
            size="small"
            disabled={items == null}
            onClick={() => setEditorOpen(true)}
          >
            <i className="fa fa-th-large me-2" /> Настроить главную
          </Button>
        )}
      />

      {saveError && (
        <div className="alert alert-warning py-2" role="alert">
          {saveError}
        </div>
      )}

      {items == null ? (
        <div className="text-muted">Загрузка…</div>
      ) : visible.length === 0 ? (
        <div className="card">
          <div className="card-body text-center py-5">
            <div className="mb-3 text-muted">На главной нет виджетов.</div>
            <Button variant="primary" size="small" onClick={() => setEditorOpen(true)}>
              Добавить виджеты
            </Button>
          </div>
        </div>
      ) : (
        <div className="row g-3 align-items-start home-dashboard-widgets mb-3">
          {visible.map((it) => {
            const { Component, title } = WIDGETS[it.type];
            return (
              <div key={it.uid} className={`${sizeColClass(it.size)} home-widget-slot`}>
                <button
                  type="button"
                  className="home-widget-remove"
                  title={`Убрать «${title}» с главной (вернуть — «Настроить главную»)`}
                  aria-label={`Убрать «${title}» с главной`}
                  disabled={saving}
                  onClick={() => removeWidget(it.uid)}
                >
                  ×
                </button>
                <Component
                  settings={it.settings || {}}
                  profileId={profileId}
                  user={user}
                  canUse={canAccess}
                  onSettingsChange={(s) => updateSettings(it.uid, s)}
                />
              </div>
            );
          })}
        </div>
      )}

      <HomeWidgetsEditor
        isOpen={editorOpen}
        items={items || []}
        canUseWidget={canAccess}
        canUseLink={canAccess}
        saving={saving}
        onClose={() => setEditorOpen(false)}
        onSave={handleSave}
        onReset={handleReset}
      />
    </div>
  );
}
