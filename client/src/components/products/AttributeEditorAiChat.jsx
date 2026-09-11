import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../common/Button/Button';
import { aiApi } from '../../services/ai.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import { instructionAllowsOverwrite, MAX_BULK_AI_CARDS } from '../../utils/aiProductCardFields.js';
import { useAiEnabled } from '../../hooks/useAiEnabled.js';
import {
  APPLICABILITY_AI_EXAMPLES,
  DEFAULT_ATTR_EDITOR_CONTEXT_FIELDS,
  DEFAULT_ATTR_EDITOR_CONTEXT_KEYS,
  filterContextForAttrEditor,
  formatAttrEditorChangesPreview,
} from '../../utils/aiAttributeEditorFields.js';
import { AiChatSettingsPanel } from './AiChatSettingsPanel.jsx';
import {
  attrAiChatSettingsRaw,
  aiChatSettingsKey,
  pickAiChatSettings,
  saveAttributeAiChatSettings,
} from '../../utils/aiChatSettings.js';
import './ProductDescriptionAiChat.css';

export function AttributeEditorAiChat({
  productId = null,
  getContext,
  outputFields = [],
  bulkItems = [],
  onApply,
  onApplyBulk,
  examples = APPLICABILITY_AI_EXAMPLES,
  title = 'ИИ',
  settingsAttribute = null,
  onSettingsSaved,
  className = '',
}) {
  const isBulk = Array.isArray(bulkItems) && bulkItems.length > 0;
  const { enabled: aiReady, loading: aiLoading } = useAiEnabled();
  const outputKeys = (outputFields || []).map((f) => f.key).filter(Boolean);
  const [selectedOutputs, setSelectedOutputs] = useState(() => [...outputKeys]);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [contextKeys, setContextKeys] = useState(() => [...DEFAULT_ATTR_EDITOR_CONTEXT_KEYS]);
  const [fillEmptyOnly, setFillEmptyOnly] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const listRef = useRef(null);

  const outputKeysSig = outputKeys.join('|');
  const settingsKey = `${aiChatSettingsKey(settingsAttribute)}|${outputKeysSig}`;
  useEffect(() => {
    const picked = pickAiChatSettings(attrAiChatSettingsRaw(settingsAttribute), {
      allowOutput: outputKeys,
      allowContext: DEFAULT_ATTR_EDITOR_CONTEXT_KEYS,
      defaultOutput: outputKeys,
      defaultContext: DEFAULT_ATTR_EDITOR_CONTEXT_KEYS,
    });
    setSelectedOutputs(picked.outputKeys);
    setContextKeys(picked.contextKeys);
    setFillEmptyOnly(picked.fillEmptyOnly);
    setInput(picked.prompt);
    setSettingsMessage('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, sending]);

  const send = async (text) => {
    const instruction = String(text || '').trim();
    if (!instruction || sending || !aiReady) return;
    const selected = (outputFields || []).filter((f) => selectedOutputs.includes(f.key));
    if (!selected.length) {
      setError('Выберите хотя бы одно поле для генерации.');
      return;
    }
    const fillEmpty = fillEmptyOnly && !instructionAllowsOverwrite(instruction);

    setMessages((prev) => [...prev, { role: 'user', content: instruction }]);
    setSending(true);
    setError(null);
    setLastResult(null);

    try {
      if (isBulk) {
        const items = bulkItems.filter((it) => it?.productId);
        if (!items.length) throw new Error('Нет сохранённых товаров для генерации');
        const allItems = [];
        for (let i = 0; i < items.length; i += MAX_BULK_AI_CARDS) {
          const chunk = items.slice(i, i + MAX_BULK_AI_CARDS).map((it) => {
            const ctx = it.context && typeof it.context === 'object' ? it.context : {};
            const context = filterContextForAttrEditor(ctx, contextKeys);
            for (const f of selected) {
              if (f.key && ctx[f.key] != null) context[f.key] = String(ctx[f.key]);
            }
            return {
              productId: it.productId,
              sku: it.sku || '',
              context,
            };
          });
          const data = await aiApi.proposeAttributeEditorBulk({
            items: chunk,
            instruction,
            outputFields: selected,
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
        const ctx = typeof getContext === 'function' ? getContext() : {};
        const context = filterContextForAttrEditor(
          { ...ctx, ...Object.fromEntries(selected.map((f) => [f.key, ctx[f.key] ?? ''])) },
          contextKeys
        );
        for (const f of selected) {
          if (f.key && ctx[f.key] != null) context[f.key] = String(ctx[f.key]);
        }
        const data = await aiApi.proposeAttributeEditor({
          productId,
          instruction,
          context,
          outputFields: selected,
          fillEmptyOnly: fillEmpty,
        });
        const reply = data?.changes?.length
          ? `${data.comment ? `${data.comment}\n\n` : ''}${formatAttrEditorChangesPreview(data.changes)}`
          : 'Модель не предложила изменений. Уточните запрос или снимите «Только пустые».';
        setLastResult({ bulk: false, data });
        setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
      }
    } catch (e) {
      setError(getApiErrorMessage(e, 'Не удалось получить ответ GigaChat'));
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
  };

  const canApply = lastResult?.bulk
    ? (lastResult.items || []).some((it) => it?.changes?.length)
    : !!(lastResult?.data?.changes?.length);

  const persistSettings = async () => {
    if (!settingsAttribute?.id) {
      setSettingsMessage('Некуда сохранить: нет id атрибута.');
      return;
    }
    setSettingsSaving(true);
    setSettingsMessage('');
    try {
      const saved = await saveAttributeAiChatSettings(settingsAttribute.id, {
        outputKeys: selectedOutputs,
        contextKeys,
        fillEmptyOnly,
        prompt: input,
      });
      onSettingsSaved?.(saved);
      setSettingsMessage('Настройки сохранены для этого атрибута');
    } catch (err) {
      setSettingsMessage(getApiErrorMessage(err, 'Не удалось сохранить настройки'));
    } finally {
      setSettingsSaving(false);
    }
  };

  if (aiLoading || !aiReady) return null;

  return (
    <div className={`product-desc-ai-chat product-desc-ai-chat--compact ${className}`.trim()}>
      <div className="product-desc-ai-chat__head">
        <strong>{title}</strong>
        {isBulk ? (
          <span className="product-desc-ai-chat__meta">товаров: {bulkItems.length}</span>
        ) : (
          <span className="product-desc-ai-chat__meta">напишите запрос или откройте настройки</span>
        )}
      </div>

      <AiChatSettingsPanel
        open={settingsOpen}
        onToggleOpen={() => setSettingsOpen((v) => !v)}
        outputDefs={outputFields || []}
        selectedOutputs={selectedOutputs}
        onChangeOutputs={setSelectedOutputs}
        contextDefs={DEFAULT_ATTR_EDITOR_CONTEXT_FIELDS}
        contextKeys={contextKeys}
        onChangeContext={setContextKeys}
        fillEmptyOnly={fillEmptyOnly}
        onChangeFillEmptyOnly={setFillEmptyOnly}
        canSave={!!settingsAttribute?.id}
        saving={settingsSaving}
        saveMessage={settingsMessage}
        onSave={persistSettings}
        disabled={sending}
      />

      <div ref={listRef} className="product-desc-ai-chat__messages">
        {messages.length === 0 ? (
          <div className="product-desc-ai-chat__examples">
            {examples.map((ex) => (
              <button key={ex} type="button" onClick={() => send(ex)} disabled={sending}>
                {ex}
              </button>
            ))}
          </div>
        ) : null}
        {messages.map((m, i) => (
          <div key={i} className={`product-desc-ai-chat__msg product-desc-ai-chat__msg--${m.role}`}>
            {m.content}
          </div>
        ))}
        {sending ? (
          <div className="product-desc-ai-chat__msg product-desc-ai-chat__msg--assistant">Готовлю текст…</div>
        ) : null}
      </div>

      {error ? <div className="product-desc-ai-chat__error">{error}</div> : null}

      <form
        className="product-desc-ai-chat__form"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          className="product-desc-ai-chat__input"
          value={input}
          disabled={sending}
          placeholder="Напишите, как заполнить выбранные поля…"
          onChange={(e) => setInput(e.target.value)}
          rows={3}
        />
        <div className="product-desc-ai-chat__actions">
          <Button type="submit" variant="primary" size="small" disabled={sending || !input.trim()}>
            Отправить
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
      </form>
    </div>
  );
}

export default AttributeEditorAiChat;
