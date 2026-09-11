import React from 'react';
import { Button } from '../common/Button/Button';

function toggleKey(list, key) {
  if (list.includes(key)) {
    const next = list.filter((k) => k !== key);
    return next.length ? next : list;
  }
  return [...list, key];
}

export function AiChatSettingsPanel({
  open,
  onToggleOpen,
  outputDefs = [],
  selectedOutputs = [],
  onChangeOutputs,
  contextDefs = [],
  contextKeys = [],
  onChangeContext,
  fillEmptyOnly,
  onChangeFillEmptyOnly,
  canSave = false,
  saving = false,
  saveMessage = '',
  onSave,
  disabled = false,
}) {
  return (
    <div className="product-desc-ai-chat__settings">
      <div className="product-desc-ai-chat__settings-bar">
        <Button type="button" variant="secondary" size="small" onClick={onToggleOpen} disabled={disabled}>
          {open ? 'Скрыть настройки' : 'Настройки'}
        </Button>
        {canSave ? (
          <Button type="button" variant="secondary" size="small" onClick={onSave} disabled={disabled || saving}>
            {saving ? 'Сохранение…' : 'Сохранить настройки'}
          </Button>
        ) : null}
        {saveMessage ? <span className="product-desc-ai-chat__meta">{saveMessage}</span> : null}
      </div>
      {open ? (
        <>
          {outputDefs.length ? (
            <div className="product-desc-ai-chat__sections">
              <p className="product-desc-ai-chat__section-title">Заполнить поля</p>
              <div className="product-desc-ai-chat__checks">
                {outputDefs.map((f) => (
                  <label key={f.key} className="product-desc-ai-chat__check">
                    <input
                      type="checkbox"
                      checked={selectedOutputs.includes(f.key)}
                      onChange={() => onChangeOutputs((prev) => toggleKey(prev, f.key))}
                      disabled={disabled}
                    />
                    {f.label}
                  </label>
                ))}
              </div>
            </div>
          ) : null}
          {contextDefs.length ? (
            <div className="product-desc-ai-chat__sections">
              <p className="product-desc-ai-chat__section-title">Учитывать при генерации</p>
              <div className="product-desc-ai-chat__checks">
                {contextDefs.map((f) => (
                  <label key={f.key} className="product-desc-ai-chat__check">
                    <input
                      type="checkbox"
                      checked={contextKeys.includes(f.key)}
                      onChange={() => onChangeContext((prev) => toggleKey(prev, f.key))}
                      disabled={disabled}
                    />
                    {f.label}
                  </label>
                ))}
              </div>
            </div>
          ) : null}
          <label className="product-desc-ai-chat__check">
            <input
              type="checkbox"
              checked={fillEmptyOnly}
              onChange={(e) => onChangeFillEmptyOnly(e.target.checked)}
              disabled={disabled}
            />
            Только пустые — не переписывать уже заполненное
          </label>
          <p className="product-desc-ai-chat__apply-hint">
            Сохранённые поля и промпт действуют для этого атрибута в карточке и в массовом заполнении.
          </p>
        </>
      ) : null}
    </div>
  );
}

export default AiChatSettingsPanel;
