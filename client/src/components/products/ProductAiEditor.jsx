import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../common/Button/Button';
import { Modal } from '../common/Modal/Modal';
import { aiApi } from '../../services/ai.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import { useAiEnabled } from '../../hooks/useAiEnabled.js';
import { instructionAllowsOverwrite, MAX_BULK_AI_CARDS } from '../../utils/aiProductCardFields.js';
import {
  buildAiContextFieldDefs,
  buildAiOutputFieldDefs,
  pickContextByKeys,
  stringifyAiContextValue,
} from '../../utils/aiContextAttributes.js';
import { formatAttrEditorChangesPreview } from '../../utils/aiAttributeEditorFields.js';
import { AiContextFieldsSelect } from './AiContextFieldsSelect.jsx';
import './ProductDescriptionAiChat.css';
import './ProductAiEditor.css';

const DEFAULT_OUTPUT_KEYS = ['name', 'description'];
const DEFAULT_CONTEXT_KEYS = ['name', 'sku', 'brand', 'description', 'category_name'];

function newTemplateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function ProductAiEditor({
  productId = null,
  getDraft,
  onApply,
  bulkItems = [],
  onApplyBulk,
  attributes = [],
}) {
  const { enabled: aiReady, loading: configLoading } = useAiEnabled();
  const isBulk = typeof onApplyBulk === 'function';
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [outputKeys, setOutputKeys] = useState(() => [...DEFAULT_OUTPUT_KEYS]);
  const [contextKeys, setContextKeys] = useState(() => [...DEFAULT_CONTEXT_KEYS]);
  const [fillEmptyOnly, setFillEmptyOnly] = useState(true);
  const [savingTpl, setSavingTpl] = useState(false);
  const [tplMessage, setTplMessage] = useState('');
  const [messages, setMessages] = useState([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const listRef = useRef(null);

  const contextDefs = useMemo(() => buildAiContextFieldDefs(attributes), [attributes]);
  const outputDefs = useMemo(() => buildAiOutputFieldDefs(attributes), [attributes]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    aiApi
      .getEditorTemplates()
      .then((data) => {
        if (cancelled) return;
        setTemplates(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, sending]);

  const applyTemplate = (tpl) => {
    if (!tpl) {
      setTemplateId('');
      setTemplateName('');
      setPrompt('');
      setOutputKeys([...DEFAULT_OUTPUT_KEYS]);
      setContextKeys([...DEFAULT_CONTEXT_KEYS]);
      setFillEmptyOnly(true);
      return;
    }
    setTemplateId(tpl.id);
    setTemplateName(tpl.name || '');
    setPrompt(tpl.prompt || '');
    setOutputKeys(tpl.outputKeys?.length ? [...tpl.outputKeys] : [...DEFAULT_OUTPUT_KEYS]);
    setContextKeys(tpl.contextKeys?.length ? [...tpl.contextKeys] : [...DEFAULT_CONTEXT_KEYS]);
    setFillEmptyOnly(tpl.fillEmptyOnly !== false);
  };

  const persistTemplates = async (nextList, okText) => {
    setSavingTpl(true);
    setTplMessage('');
    try {
      const saved = await aiApi.saveEditorTemplates(nextList);
      const list = Array.isArray(saved) ? saved : nextList;
      setTemplates(list);
      setTplMessage(okText);
      return list;
    } catch (err) {
      setTplMessage(getApiErrorMessage(err, 'Не удалось сохранить шаблоны'));
      return null;
    } finally {
      setSavingTpl(false);
    }
  };

  const saveCurrentTemplate = async () => {
    const name = String(templateName || '').trim() || 'Шаблон';
    const payload = {
      id: templateId || newTemplateId(),
      name,
      prompt,
      outputKeys,
      contextKeys,
      fillEmptyOnly,
    };
    const exists = templates.some((t) => t.id === payload.id);
    const next = exists
      ? templates.map((t) => (t.id === payload.id ? payload : t))
      : [...templates, payload];
    const list = await persistTemplates(next, exists ? 'Шаблон обновлён' : 'Шаблон сохранён');
    if (list) {
      setTemplateId(payload.id);
      setTemplateName(payload.name);
    }
  };

  const deleteCurrentTemplate = async () => {
    if (!templateId) return;
    const next = templates.filter((t) => t.id !== templateId);
    const list = await persistTemplates(next, 'Шаблон удалён');
    if (list) applyTemplate(null);
  };

  const selectedOutputs = outputDefs.filter((f) => outputKeys.includes(f.key));

  const send = async () => {
    const instruction = String(prompt || '').trim();
    if (!instruction || sending || !aiReady) return;
    if (!selectedOutputs.length) {
      setError('Выберите хотя бы одно поле для заполнения.');
      return;
    }
    const fillEmpty = fillEmptyOnly && !instructionAllowsOverwrite(instruction);
    setMessages((prev) => [...prev, { role: 'user', content: instruction }]);
    setSending(true);
    setError(null);
    setLastResult(null);
    try {
      const buildContext = (draft) => {
        const src = draft && typeof draft === 'object' ? draft : {};
        const context = pickContextByKeys(src, contextKeys, contextDefs);
        for (const f of selectedOutputs) {
          context[f.key] = stringifyAiContextValue(src[f.key]);
        }
        return context;
      };
      if (isBulk) {
        const items = bulkItems.filter((it) => it?.productId);
        if (!items.length) throw new Error('Нет сохранённых товаров для генерации');
        const allItems = [];
        for (let i = 0; i < items.length; i += MAX_BULK_AI_CARDS) {
          const chunk = items.slice(i, i + MAX_BULK_AI_CARDS).map((it) => ({
            productId: it.productId,
            sku: it.sku || '',
            context: buildContext(it.draft || it.context),
          }));
          const data = await aiApi.proposeAttributeEditorBulk({
            items: chunk,
            instruction,
            outputFields: selectedOutputs,
            fillEmptyOnly: fillEmpty,
          });
          allItems.push(...(data?.items || []));
        }
        const changed = allItems.filter((it) => it?.changes?.length);
        const reply = changed.length
          ? `Готово для ${changed.length} из ${items.length} товаров.\n\n${changed
              .slice(0, 3)
              .map((it) => `${it.sku || it.productId}:\n${formatAttrEditorChangesPreview(it.changes)}`)
              .join('\n\n')}${changed.length > 3 ? `\n\n…и ещё ${changed.length - 3}` : ''}`
          : 'Модель не предложила изменений. Уточните запрос или снимите «Только пустые».';
        setLastResult({ bulk: true, items: allItems });
        setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
      } else {
        const ctx = typeof getDraft === 'function' ? getDraft() : {};
        const data = await aiApi.proposeAttributeEditor({
          productId,
          instruction,
          context: buildContext(ctx),
          outputFields: selectedOutputs,
          fillEmptyOnly: fillEmpty,
        });
        const reply = data?.changes?.length
          ? `${data.comment ? `${data.comment}\n\n` : ''}${formatAttrEditorChangesPreview(data.changes)}`
          : 'Модель не предложила изменений. Уточните запрос или снимите «Только пустые».';
        setLastResult({ bulk: false, data });
        setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
      }
    } catch (err) {
      setError(getApiErrorMessage(err, 'Не удалось получить ответ GigaChat'));
    } finally {
      setSending(false);
    }
  };

  const applyLast = () => {
    if (!lastResult) return;
    if (lastResult.bulk) {
      const items = (lastResult.items || []).filter((it) => it?.changes?.length);
      if (items.length) onApplyBulk?.(items);
    } else if (lastResult.data?.proposed && Object.keys(lastResult.data.proposed).length) {
      onApply?.(lastResult.data.proposed);
    }
    setOpen(false);
  };

  const canApply = lastResult?.bulk
    ? (lastResult.items || []).some((it) => it?.changes?.length)
    : !!(lastResult?.data?.changes?.length);

  if (configLoading || !aiReady) return null;

  return (
    <>
      {open ? null : (
        <button type="button" className="product-ai-fab" onClick={() => setOpen(true)} title="ИИ-редактор">
          ИИ
        </button>
      )}
      <Modal isOpen={open} onClose={() => setOpen(false)} title="ИИ-редактор" size="large" scrollable>
        <div className="product-ai-editor">
          <div className="product-ai-editor__templates">
            <label className="product-ai-editor__field">
              <span>Шаблон</span>
              <select
                className="form-select form-select-sm"
                value={templateId}
                onChange={(e) => {
                  const id = e.target.value;
                  applyTemplate(templates.find((t) => t.id === id) || null);
                }}
              >
                <option value="">Без шаблона — настроить сейчас</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="product-ai-editor__field product-ai-editor__field--grow">
              <span>Название шаблона</span>
              <input
                className="form-control form-control-sm"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="Например: Продающие названия"
                maxLength={80}
              />
            </label>
            <div className="product-ai-editor__tpl-actions">
              <Button type="button" variant="secondary" size="small" onClick={saveCurrentTemplate} disabled={savingTpl}>
                {savingTpl ? 'Сохранение…' : templateId ? 'Сохранить шаблон' : 'Создать шаблон'}
              </Button>
              {templateId ? (
                <Button type="button" variant="secondary" size="small" onClick={deleteCurrentTemplate} disabled={savingTpl}>
                  Удалить
                </Button>
              ) : null}
            </div>
            {tplMessage ? <span className="product-ai-editor__meta">{tplMessage}</span> : null}
          </div>

          {isBulk ? (
            <p className="product-ai-editor__meta mb-0">товаров: {bulkItems.length}</p>
          ) : null}

          <div className="product-ai-editor__section">
            <p className="product-ai-editor__label">Заполнить поля</p>
            <AiContextFieldsSelect
              options={outputDefs}
              value={outputKeys}
              onChange={setOutputKeys}
              disabled={sending}
              placeholder="Выберите поля для генерации"
            />
          </div>
          <div className="product-ai-editor__section">
            <p className="product-ai-editor__label">Учитывать при генерации</p>
            <AiContextFieldsSelect
              options={contextDefs}
              value={contextKeys}
              onChange={setContextKeys}
              disabled={sending}
              placeholder="Выберите поля-источники"
            />
          </div>
          <label className="product-desc-ai-chat__check">
            <input
              type="checkbox"
              checked={fillEmptyOnly}
              onChange={(e) => setFillEmptyOnly(e.target.checked)}
              disabled={sending}
            />
            Только пустые — не переписывать уже заполненное
          </label>

          <div className="product-desc-ai-chat__messages" ref={listRef}>
            {messages.length === 0 ? (
              <p className="product-ai-editor__hint">
                Настройте поля или выберите шаблон, напишите промпт и нажмите «Сгенерировать».
              </p>
            ) : null}
            {messages.map((msg, idx) => (
              <div key={`${msg.role}-${idx}`} className={`product-desc-ai-chat__msg product-desc-ai-chat__msg--${msg.role}`}>
                {msg.content}
              </div>
            ))}
            {sending ? (
              <div className="product-desc-ai-chat__msg product-desc-ai-chat__msg--assistant">Готовлю текст…</div>
            ) : null}
          </div>
          {error ? <div className="product-desc-ai-chat__error">{error}</div> : null}

          <textarea
            className="product-desc-ai-chat__input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Промпт: как заполнить выбранные поля…"
            disabled={sending}
            rows={4}
          />
          <div className="product-desc-ai-chat__actions">
            <Button type="button" variant="primary" size="small" disabled={sending || !prompt.trim()} onClick={() => send()}>
              Сгенерировать
            </Button>
            {canApply ? (
              <Button type="button" variant="secondary" size="small" onClick={applyLast} disabled={sending}>
                Подставить результат
              </Button>
            ) : null}
          </div>
          <p className="product-desc-ai-chat__apply-hint">
            В ERP и на МП ничего не уходит, пока не нажмёте «Сохранить» в карточке или таблице.
          </p>
        </div>
      </Modal>
    </>
  );
}

export default ProductAiEditor;
