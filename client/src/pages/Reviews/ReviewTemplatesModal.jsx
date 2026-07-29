/**
 * Управление шаблонами и правилами автоответа на отзывы
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import {
  reviewAnswerTemplatesApi,
  reviewAutoReplyRulesApi,
} from '../../services/reviewAnswerTemplates.api';
import { REVIEW_TEMPLATE_PRODUCT_TOKEN } from './reviewTemplateText';

const EMPTY_FORM = { title: '', body: '' };

const EMPTY_RULE = {
  localKey: '',
  id: null,
  title: '',
  rating: '',
  hasText: 'any',
  templateId: '',
  enabled: true,
};

function newLocalRule() {
  return {
    ...EMPTY_RULE,
    localKey: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  };
}

function ruleFromApi(r) {
  return {
    localKey: String(r.id || `r-${Math.random().toString(36).slice(2, 7)}`),
    id: r.id != null ? String(r.id) : null,
    title: r.title || '',
    rating: r.rating != null ? String(r.rating) : '',
    hasText: r.hasText === true ? 'yes' : r.hasText === false ? 'no' : 'any',
    templateId: r.templateId != null ? String(r.templateId) : '',
    enabled: Boolean(r.enabled),
  };
}

function ruleToApi(r) {
  return {
    title: String(r.title || '').trim(),
    rating: r.rating === '' || r.rating == null ? null : Number(r.rating),
    hasText: r.hasText === 'yes' ? true : r.hasText === 'no' ? false : null,
    templateId: r.templateId || null,
    enabled: Boolean(r.enabled) && Boolean(r.templateId),
  };
}

export function ReviewTemplatesModal({
  isOpen,
  onClose,
  prefetchedTemplates = [],
  onChange = null,
}) {
  const [tab, setTab] = useState('templates');
  const [items, setItems] = useState([]);
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const [rulesInfo, setRulesInfo] = useState('');

  const notify = () => {
    if (typeof onChange === 'function') onChange();
  };

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const [tpl, ruleList] = await Promise.all([
        reviewAnswerTemplatesApi.getAll(),
        reviewAutoReplyRulesApi.getAll(),
      ]);
      setItems(Array.isArray(tpl) ? tpl : []);
      setRules(Array.isArray(ruleList) ? ruleList.map(ruleFromApi) : []);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить настройки');
      setItems([]);
      setRules([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setTab('templates');
    setEditingId(null);
    setForm(EMPTY_FORM);
    if (Array.isArray(prefetchedTemplates) && prefetchedTemplates.length > 0) {
      setItems(prefetchedTemplates);
    }
    void load();
  }, [isOpen, load, prefetchedTemplates]);

  const startEdit = (tpl) => {
    setEditingId(String(tpl.id));
    setForm({ title: tpl.title || '', body: tpl.body || '' });
    setError('');
  };

  const startCreate = () => {
    setEditingId('new');
    setForm(EMPTY_FORM);
    setError('');
  };

  const cancelForm = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError('');
  };

  const insertProductToken = () => {
    setForm((prev) => ({
      ...prev,
      body: `${prev.body || ''}${prev.body ? ' ' : ''}${REVIEW_TEMPLATE_PRODUCT_TOKEN}`,
    }));
  };

  const saveForm = async () => {
    const title = String(form.title ?? '').trim();
    const body = String(form.body ?? '');
    if (!title) {
      setError('Укажите название шаблона');
      return;
    }
    try {
      setSaving(true);
      setError('');
      if (editingId === 'new') {
        const created = await reviewAnswerTemplatesApi.create({ title, body });
        setItems((prev) => [...prev, created]);
      } else {
        const updated = await reviewAnswerTemplatesApi.update(editingId, { title, body });
        setItems((prev) => prev.map((t) => (String(t.id) === String(editingId) ? updated : t)));
      }
      cancelForm();
      notify();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось сохранить шаблон');
    } finally {
      setSaving(false);
    }
  };

  const removeTemplate = async (id) => {
    if (!window.confirm('Удалить этот шаблон?')) return;
    try {
      setSaving(true);
      setError('');
      await reviewAnswerTemplatesApi.remove(id);
      setItems((prev) => prev.filter((t) => String(t.id) !== String(id)));
      setRules((prev) =>
        prev.map((r) =>
          String(r.templateId) === String(id) ? { ...r, templateId: '', enabled: false } : r
        )
      );
      if (String(editingId) === String(id)) cancelForm();
      notify();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось удалить шаблон');
    } finally {
      setSaving(false);
    }
  };

  const updateRuleLocal = (localKey, patch) => {
    setRules((prev) => prev.map((r) => (r.localKey === localKey ? { ...r, ...patch } : r)));
  };

  const addRule = () => {
    setRules((prev) => [...prev, newLocalRule()]);
  };

  const removeRule = (localKey) => {
    setRules((prev) => prev.filter((r) => r.localKey !== localKey));
  };

  const saveRules = async () => {
    for (const r of rules) {
      if (!String(r.title || '').trim()) {
        setError('У каждой категории должно быть название');
        return;
      }
    }
    try {
      setSaving(true);
      setError('');
      setRulesInfo('');
      const payload = rules.map(ruleToApi);
      const res = await reviewAutoReplyRulesApi.saveAll(payload);
      const saved = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      setRules(saved.map(ruleFromApi));
      const ar = res?.autoReply;
      if (ar) {
        setRulesInfo(
          `Сохранено. Автоответов отправлено: ${ar.answered ?? 0}` +
            (Array.isArray(ar.errors) && ar.errors.length ? ` (ошибок: ${ar.errors.length})` : '')
        );
      } else {
        setRulesInfo('Категории сохранены');
      }
      notify();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось сохранить категории');
    } finally {
      setSaving(false);
    }
  };

  const runAutoRepliesNow = async () => {
    try {
      setSaving(true);
      setError('');
      setRulesInfo('');
      const out = await reviewAutoReplyRulesApi.runNow();
      setRulesInfo(
        `Автоответов отправлено: ${out?.answered ?? 0}` +
          (out?.candidates != null ? ` из ${out.candidates} подходящих` : '') +
          (Array.isArray(out?.errors) && out.errors.length ? ` (ошибок: ${out.errors.length})` : '')
      );
      notify();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось запустить автоответы');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Шаблоны и автоответы" size="large" usePortal>
      <div className="reviews-templates-modal">
        <div className="reviews-templates-tabs">
          <button
            type="button"
            className={`reviews-templates-tab${tab === 'templates' ? ' is-active' : ''}`}
            onClick={() => setTab('templates')}
          >
            Шаблоны
          </button>
          <button
            type="button"
            className={`reviews-templates-tab${tab === 'rules' ? ' is-active' : ''}`}
            onClick={() => setTab('rules')}
          >
            Автоответы
          </button>
        </div>

        {error && <div className="error reviews-templates-error">{error}</div>}

        {loading && items.length === 0 && rules.length === 0 ? (
          <div className="loading">Загрузка…</div>
        ) : null}

        {tab === 'templates' ? (
          <div className="reviews-templates-pane">
            <p className="text-muted small">
              Плейсхолдер <code>{REVIEW_TEMPLATE_PRODUCT_TOKEN}</code> подставит артикул из отзыва.
            </p>
            {items.length === 0 && editingId !== 'new' ? (
              <p className="text-muted small">Шаблонов пока нет. Добавьте первый.</p>
            ) : (
              <div className="reviews-templates-list">
                {items.map((tpl) => (
                  <div key={tpl.id} className="reviews-templates-item">
                    <div className="reviews-templates-item__main">
                      <strong>{tpl.title}</strong>
                      <p className="text-muted small reviews-templates-item__preview">
                        {(tpl.body || '').slice(0, 160)}
                        {(tpl.body || '').length > 160 ? '…' : ''}
                      </p>
                    </div>
                    <div className="reviews-templates-item__actions">
                      <Button type="button" variant="secondary" size="small" onClick={() => startEdit(tpl)} disabled={saving}>
                        Изменить
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        onClick={() => void removeTemplate(tpl.id)}
                        disabled={saving}
                      >
                        Удалить
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {editingId ? (
              <div className="reviews-templates-form">
                <label className="reviews-filter-label" htmlFor="review-tpl-title">
                  Название
                </label>
                <input
                  id="review-tpl-title"
                  className="form-control form-control-sm"
                  value={form.title}
                  onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
                  disabled={saving}
                />
                <div className="d-flex justify-content-between align-items-center mt-2">
                  <label className="reviews-filter-label mb-0" htmlFor="review-tpl-body">
                    Текст ответа
                  </label>
                  <Button type="button" variant="secondary" size="small" onClick={insertProductToken} disabled={saving}>
                    + Артикул
                  </Button>
                </div>
                <textarea
                  id="review-tpl-body"
                  className="form-control form-control-sm mt-1"
                  rows={5}
                  value={form.body}
                  onChange={(e) => setForm((p) => ({ ...p, body: e.target.value }))}
                  disabled={saving}
                />
                <div className="d-flex gap-2 mt-2">
                  <Button type="button" variant="primary" size="small" onClick={() => void saveForm()} disabled={saving}>
                    Сохранить
                  </Button>
                  <Button type="button" variant="secondary" size="small" onClick={cancelForm} disabled={saving}>
                    Отмена
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-3">
                <Button type="button" variant="primary" size="small" onClick={startCreate} disabled={saving}>
                  Добавить шаблон
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="reviews-templates-pane">
            <p className="text-muted small">
              Создайте свои категории автоответа: название, звёзды, наличие текста и шаблон.
              Автоответы уходят после синхронизации отзывов (раз в час) и сразу при сохранении
              категорий / кнопке «Ответить сейчас».
            </p>
            {rulesInfo ? <p className="text-muted small reviews-rules-info">{rulesInfo}</p> : null}
            {rules.length === 0 ? (
              <p className="text-muted small">Категорий пока нет. Добавьте первую.</p>
            ) : (
              <div className="reviews-auto-rules-list">
                {rules.map((r) => (
                  <div key={r.localKey} className="reviews-auto-rule-card">
                    <div className="reviews-auto-rule-card__row">
                      <label className="reviews-filter-label">
                        Название
                        <input
                          className="form-control form-control-sm"
                          value={r.title}
                          placeholder="Например: 5★ с текстом"
                          onChange={(e) => updateRuleLocal(r.localKey, { title: e.target.value })}
                          disabled={saving}
                        />
                      </label>
                      <label className="reviews-filter-label">
                        Звёзды
                        <select
                          className="form-select form-select-sm"
                          value={r.rating}
                          onChange={(e) => updateRuleLocal(r.localKey, { rating: e.target.value })}
                          disabled={saving}
                        >
                          <option value="">Любые</option>
                          <option value="5">5★</option>
                          <option value="4">4★</option>
                          <option value="3">3★</option>
                          <option value="2">2★</option>
                          <option value="1">1★</option>
                        </select>
                      </label>
                      <label className="reviews-filter-label">
                        Текст
                        <select
                          className="form-select form-select-sm"
                          value={r.hasText}
                          onChange={(e) => updateRuleLocal(r.localKey, { hasText: e.target.value })}
                          disabled={saving}
                        >
                          <option value="any">Любой</option>
                          <option value="yes">С текстом</option>
                          <option value="no">Без текста</option>
                        </select>
                      </label>
                    </div>
                    <div className="reviews-auto-rule-card__row">
                      <label className="reviews-filter-label reviews-auto-rule-card__tpl">
                        Шаблон
                        <select
                          className="form-select form-select-sm"
                          value={r.templateId}
                          onChange={(e) =>
                            updateRuleLocal(r.localKey, {
                              templateId: e.target.value,
                              enabled: e.target.value ? r.enabled : false,
                            })
                          }
                          disabled={saving}
                        >
                          <option value="">— не выбран —</option>
                          {items.map((tpl) => (
                            <option key={tpl.id} value={tpl.id}>
                              {tpl.title}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="reviews-auto-rule-card__enabled">
                        <input
                          type="checkbox"
                          checked={Boolean(r.enabled) && Boolean(r.templateId)}
                          disabled={saving || !r.templateId}
                          onChange={(e) => updateRuleLocal(r.localKey, { enabled: e.target.checked })}
                        />
                        Вкл.
                      </label>
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        onClick={() => removeRule(r.localKey)}
                        disabled={saving}
                      >
                        Удалить
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="d-flex gap-2 mt-3 flex-wrap">
              <Button type="button" variant="secondary" size="small" onClick={addRule} disabled={saving}>
                Добавить категорию
              </Button>
              <Button type="button" variant="primary" size="small" onClick={() => void saveRules()} disabled={saving}>
                Сохранить категории
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="small"
                onClick={() => void runAutoRepliesNow()}
                disabled={saving || rules.length === 0}
              >
                Ответить сейчас
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
