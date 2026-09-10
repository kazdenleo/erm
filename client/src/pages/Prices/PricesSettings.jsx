/**
 * Настройки раздела «Цены»: отправка на МП + градации мин. наценки.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { PricesPushSettingsPanel, buildScopeSummaryText } from './PricesPushSettingsPanel.jsx';
import { PricesMinMarkupRulesPanel } from './PricesMinMarkupRulesPanel.jsx';
import { pricesApi } from '../../services/prices.api.js';
import { useCategories } from '../../hooks/useCategories.js';
import { useOrganizations } from '../../hooks/useOrganizations.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { isProfileFbsEnabled, isProfileFboEnabled } from '../../utils/profileFlags.js';
import './Prices.css';

const TABS = {
  push: 'push',
  markup: 'markup',
};

export function PricesSettings() {
  const { profile } = useAuth();
  const showFbsOption = isProfileFbsEnabled(profile);
  const showFboOption = isProfileFboEnabled(profile);
  const { categories } = useCategories();
  const { organizations, updateOrganization } = useOrganizations();

  const [tab, setTab] = useState(TABS.push);
  const [pushSettingsSummary, setPushSettingsSummary] = useState(null);
  const [markupRules, setMarkupRules] = useState([]);
  const [markupLoading, setMarkupLoading] = useState(false);
  const [markupSaving, setMarkupSaving] = useState(false);
  const [markupMessage, setMarkupMessage] = useState(null);
  const [markupError, setMarkupError] = useState(null);
  const [pushLoading, setPushLoading] = useState(false);
  const [pushFeedback, setPushFeedback] = useState(null);

  const loadSettings = useCallback(async () => {
    setMarkupLoading(true);
    setMarkupError(null);
    try {
      const res = await pricesApi.getPushSettings();
      const data = res?.data ?? res;
      setPushSettingsSummary(data);
      setMarkupRules(Array.isArray(data?.minMarkupRules) ? data.minMarkupRules : []);
    } catch (err) {
      setMarkupError(err.response?.data?.message || err.message || 'Не удалось загрузить настройки');
    } finally {
      setMarkupLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleOrgPushToggle = async (orgId, data) => {
    await updateOrganization(orgId, data);
    setPushSettingsSummary((prev) => {
      if (!prev?.organizations) return prev;
      return {
        ...prev,
        organizations: prev.organizations.map((o) =>
          String(o.id) === String(orgId)
            ? { ...o, autoPushMarketplacePrices: data.auto_push_marketplace_prices === true }
            : o
        ),
      };
    });
  };

  const getEnabledPushOrgs = (settings) => {
    const list = settings?.organizations || organizations;
    return (list || []).filter(
      (o) => o.autoPushMarketplacePrices === true || o.auto_push_marketplace_prices === true
    );
  };

  const handlePushNow = async (savedPayload, opts = {}) => {
    const summarySettings = {
      ...(pushSettingsSummary || {}),
      ...(savedPayload || {}),
      organizations:
        opts.organizations ||
        pushSettingsSummary?.organizations ||
        organizations.map((o) => ({
          id: o.id,
          name: o.name,
          autoPushMarketplacePrices: o.auto_push_marketplace_prices === true,
        })),
    };
    const enabledOrgs = getEnabledPushOrgs(summarySettings);
    if (!enabledOrgs.length) {
      const msg = 'Ошибка: ни у одной организации не включена отправка цен на маркетплейсы.';
      setPushFeedback(msg);
      setTimeout(() => setPushFeedback(null), 10000);
      throw new Error(msg);
    }

    if (!opts.skipConfirm) {
      const scopeHint = buildScopeSummaryText(savedPayload || pushSettingsSummary);
      const ok = window.confirm(
        `Отправить сохранённые минимальные цены на маркетплейсы?\n\nОбласть: ${scopeHint}.\nОрганизации: ${enabledOrgs.map((o) => o.name).join(', ')}.\n\nОперация выполняется в фоне.`
      );
      if (!ok) return;
    }

    setPushLoading(true);
    setPushFeedback(null);
    try {
      const res = await pricesApi.pushAll({ useSavedSettings: true });
      setPushFeedback(res?.message || 'Отправка цен на маркетплейсы запущена в фоне.');
      setTimeout(() => setPushFeedback(null), 15000);
    } catch (err) {
      const msg = 'Ошибка: ' + (err.response?.data?.message || err.message);
      setPushFeedback(msg);
      setTimeout(() => setPushFeedback(null), 10000);
      throw err;
    } finally {
      setPushLoading(false);
    }
  };

  const saveMarkupRules = async () => {
    setMarkupSaving(true);
    setMarkupError(null);
    setMarkupMessage(null);
    try {
      const res = await pricesApi.updatePushSettings({ minMarkupRules: markupRules });
      const saved = res?.data ?? res;
      setMarkupRules(saved?.minMarkupRules || markupRules);
      setPushSettingsSummary((prev) => ({
        ...(prev || {}),
        minMarkupRules: saved?.minMarkupRules || markupRules,
      }));
      setMarkupMessage('Правила наценки сохранены');
      setTimeout(() => setMarkupMessage(null), 4000);
    } catch (err) {
      setMarkupError(err.response?.data?.message || err.message || 'Ошибка сохранения');
    } finally {
      setMarkupSaving(false);
    }
  };

  return (
    <div className="card">
      <div className="d-flex flex-wrap align-items-start justify-content-between gap-2 mb-3">
        <div>
          <h1 className="title mb-1">Настройки цен</h1>
          <p className="text-muted small mb-0">
            Отправка минимумов на маркетплейсы и градации мин. наценки.{' '}
            <Link to="/prices">К минимальным ценам</Link>
          </p>
        </div>
      </div>

      <div className="d-flex gap-2 mb-3 flex-wrap">
        <button
          type="button"
          className="btn btn-sm"
          style={{
            background: tab === TABS.push ? 'rgba(59,130,246,0.25)' : 'transparent',
            border: '1px solid rgba(255,255,255,0.15)',
            color: tab === TABS.push ? '#fff' : 'var(--muted)',
          }}
          onClick={() => setTab(TABS.push)}
        >
          Отправка на маркетплейсы
        </button>
        <button
          type="button"
          className="btn btn-sm"
          style={{
            background: tab === TABS.markup ? 'rgba(59,130,246,0.25)' : 'transparent',
            border: '1px solid rgba(255,255,255,0.15)',
            color: tab === TABS.markup ? '#fff' : 'var(--muted)',
          }}
          onClick={() => setTab(TABS.markup)}
        >
          Мин. наценки (градации)
        </button>
      </div>

      {tab === TABS.push && (
        <PricesPushSettingsPanel
          categories={categories}
          showUncategorizedCategoryOption
          showFbsOption={showFbsOption}
          showFboOption={showFboOption}
          organizations={organizations}
          onOrganizationsChange={handleOrgPushToggle}
          onSaved={(payload) =>
            setPushSettingsSummary((prev) => ({
              ...(prev || {}),
              ...payload,
              organizations: prev?.organizations,
            }))
          }
          onPushNow={handlePushNow}
          pushLoading={pushLoading}
          pushFeedback={pushFeedback}
        />
      )}

      {tab === TABS.markup && (
        <div>
          {markupError && <div className="error mb-2">{markupError}</div>}
          {markupMessage && (
            <div className="small mb-2" style={{ color: 'var(--primary)' }}>
              {markupMessage}
            </div>
          )}
          {markupLoading ? (
            <p className="text-muted small">Загрузка…</p>
          ) : (
            <>
              <PricesMinMarkupRulesPanel
                rules={markupRules}
                onChange={setMarkupRules}
                categories={categories}
                showUncategorizedCategoryOption
              />
              <div className="d-flex gap-2 mt-3">
                <Button
                  type="button"
                  variant="primary"
                  size="small"
                  disabled={markupSaving}
                  onClick={saveMarkupRules}
                >
                  {markupSaving ? 'Сохранение…' : 'Сохранить правила наценки'}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
