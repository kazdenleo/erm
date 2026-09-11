import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../common/Button/Button';
import { aiApi } from '../../services/ai.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import { instructionAllowsOverwrite, MAX_BULK_AI_CARDS } from '../../utils/aiProductCardFields.js';
import { useAiEnabled } from '../../hooks/useAiEnabled.js';
import {
  AI_DESCRIPTION_CONTEXT_KEYS,
  AI_DESCRIPTION_OUTPUT_FIELDS,
  AI_DESCRIPTION_OUTPUT_KEYS,
  DESCRIPTION_AI_EXAMPLES,
  filterDraftForAiContext,
  formatAiChangesPreview,
} from '../../utils/aiDescriptionFields.js';
import { buildAiContextFieldDefs } from '../../utils/aiContextAttributes.js';
import { AiChatSettingsPanel } from './AiChatSettingsPanel.jsx';
import {
  attrAiChatSettingsRaw,
  aiChatSettingsKey,
  pickAiChatSettings,
  saveAttributeAiChatSettings,
} from '../../utils/aiChatSettings.js';
import './ProductDescriptionAiChat.css';

export function ProductDescriptionAiChat({
  compact = false,
  embedded = false,
  disabled = false,
  productId = null,
  getDraft,
  bulkItems = [],
  onApply,
  onApplyBulk,
  settingsAttribute = null,
  onSettingsSaved,
  contextAttributes = [],
  className = '',
}) {
  const isBulk = Array.isArray(bulkItems) && bulkItems.length > 0;
  const contextDefs = useMemo(
    () => buildAiContextFieldDefs(contextAttributes),
    [contextAttributes]
  );
  const contextAllowKeys = useMemo(() => contextDefs.map((f) => f.key), [contextDefs]);
  const { enabled: aiReady, loading: configLoading } = useAiEnabled();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [outputFields, setOutputFields] = useState(() => [...AI_DESCRIPTION_OUTPUT_KEYS]);
  const [contextFields, setContextFields] = useState(() => [...AI_DESCRIPTION_CONTEXT_KEYS]);
  const [fillEmptyOnly, setFillEmptyOnly] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const listRef = useRef(null);

  const settingsKey = `${aiChatSettingsKey(settingsAttribute)}|${contextAllowKeys.join('|')}`;
  useEffect(() => {
    const picked = pickAiChatSettings(attrAiChatSettingsRaw(settingsAttribute), {
      allowOutput: AI_DESCRIPTION_OUTPUT_KEYS,
      allowContext: contextAllowKeys,
      defaultOutput: AI_DESCRIPTION_OUTPUT_KEYS,
      defaultContext: AI_DESCRIPTION_CONTEXT_KEYS,
    });
    setOutputFields(picked.outputKeys);
    setContextFields(picked.contextKeys);
    setFillEmptyOnly(picked.fillEmptyOnly);
    setInput(picked.prompt);
    setSettingsMessage('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, sending]);

  const ready = aiReady && !disabled;

  const send = async (text) => {
    const instruction = String(text || '').trim();
    if (!instruction || sending || !ready) return;
    const fillEmpty = fillEmptyOnly && !instructionAllowsOverwrite(instruction);
    const fields = outputFields.filter((k) => AI_DESCRIPTION_OUTPUT_KEYS.includes(k));
    if (!fields.length) {
      setError('Выберите хотя бы одно поле описания для генерации.');
      return;
    }

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
          const chunk = items.slice(i, i + MAX_BULK_AI_CARDS).map((it) => ({
            productId: it.productId,
            draft: filterDraftForAiContext(it.draft, contextFields, contextDefs),
          }));
          const data = await aiApi.proposeProductCardsBulk({
            items: chunk,
            instruction,
            fields,
            fillEmptyOnly: fillEmpty,
          });
          allItems.push(...(data?.items || []));
        }
        const changed = allItems.filter((it) => it?.changes?.length);
        const reply = changed.length
          ? `Готово для ${changed.length} из ${items.length} товаров.\n\n${changed
              .slice(0, 3)
              .map((it) => `${it.sku || it.productId}:\n${formatAiChangesPreview(it.changes)}`)
              .join('\n\n')}${changed.length > 3 ? `\n\n…и ещё ${changed.length - 3}` : ''}`
          : 'Модель не предложила изменений. Уточните запрос или снимите «Только пустые».';
        setLastResult({ bulk: true, items: allItems });
        setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
      } else {
        const draft =
          typeof getDraft === 'function' ? filterDraftForAiContext(getDraft(), contextFields, contextDefs) : {};
        const data = await aiApi.proposeProductCard({
          productId: productId || undefined,
          draft,
          instruction,
          fields,
          fillEmptyOnly: fillEmpty,
        });
        const reply = data?.changes?.length
          ? `${data.comment ? `${data.comment}\n\n` : ''}${formatAiChangesPreview(data.changes)}`
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
      onApply?.(lastResult.data.proposed, lastResult.data);
    }
  };

  const canApply = lastResult?.bulk
    ? (lastResult.items || []).some((it) => it?.changes?.length)
    : !!(lastResult?.data?.changes?.length);

  const persistSettings = async () => {
    if (!settingsAttribute?.id) {
      setSettingsMessage('Нет системного атрибута «Описание» — настройки некуда сохранить.');
      return;
    }
    setSettingsSaving(true);
    setSettingsMessage('');
    try {
      const payload = {
        outputKeys: outputFields,
        contextKeys: contextFields,
        fillEmptyOnly,
        prompt: input,
      };
      const saved = await saveAttributeAiChatSettings(settingsAttribute.id, payload);
      onSettingsSaved?.(saved);
      setSettingsMessage('Настройки сохранены для описания');
    } catch (err) {
      setSettingsMessage(getApiErrorMessage(err, 'Не удалось сохранить настройки'));
    } finally {
      setSettingsSaving(false);
    }
  };

  if (configLoading || !ready) return null;

  return (
    <div
      className={`product-desc-ai-chat${compact ? ' product-desc-ai-chat--compact' : ''}${
        embedded ? ' product-desc-ai-chat--embedded' : ''
      }${className ? ` ${className}` : ''}`}
    >
      {embedded ? null : (
        <div className="product-desc-ai-chat__head">
          <strong>ИИ — описание</strong>
          {isBulk ? <span className="product-desc-ai-chat__meta">товаров: {bulkItems.length}</span> : null}
        </div>
      )}
      {isBulk && embedded ? (
        <p className="product-desc-ai-chat__meta mb-0">товаров: {bulkItems.length}</p>
      ) : null}

      <AiChatSettingsPanel
        open={settingsOpen}
        onToggleOpen={() => setSettingsOpen((v) => !v)}
        outputDefs={AI_DESCRIPTION_OUTPUT_FIELDS}
        selectedOutputs={outputFields}
        onChangeOutputs={setOutputFields}
        contextDefs={contextDefs}
        contextKeys={contextFields}
        onChangeContext={setContextFields}
        fillEmptyOnly={fillEmptyOnly}
        onChangeFillEmptyOnly={setFillEmptyOnly}
        canSave={!!settingsAttribute?.id}
        saving={settingsSaving}
        saveMessage={settingsMessage}
        onSave={persistSettings}
        disabled={sending}
      />

      <div className="product-desc-ai-chat__messages" ref={listRef}>
        {messages.length === 0 ? (
          <div className="product-desc-ai-chat__examples">
            {DESCRIPTION_AI_EXAMPLES.map((q) => (
              <button key={q} type="button" onClick={() => send(q)} disabled={sending}>
                {q}
              </button>
            ))}
          </div>
        ) : null}
        {messages.map((msg, idx) => (
          <div key={`${msg.role}-${idx}`} className={`product-desc-ai-chat__msg product-desc-ai-chat__msg--${msg.role}`}>
            {msg.content}
          </div>
        ))}
        {sending ? (
          <div className="product-desc-ai-chat__msg product-desc-ai-chat__msg--assistant">Готовлю описание…</div>
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
          onChange={(e) => setInput(e.target.value)}
          placeholder="Напишите, как изменить описание…"
          disabled={sending}
          rows={compact ? 2 : 3}
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
          В ERP и на МП ничего не уходит, пока не нажмёте «Сохранить» в таблице или карточке.
        </p>
      </form>
    </div>
  );
}
