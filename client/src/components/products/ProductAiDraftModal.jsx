import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from '../common/Modal/Modal';
import { Button } from '../common/Button/Button';
import { aiApi } from '../../services/ai.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import {
  AI_CARD_FIELDS,
  AI_CARD_FIELD_KEYS,
  MAX_BULK_AI_CARDS,
  instructionAllowsOverwrite,
} from '../../utils/aiProductCardFields.js';
import './ProductAiDraftModal.css';

const EXAMPLES = [
  'Заполни пустые названия и описания по данным карточки',
  'Сделай короткие продающие названия для Ozon, WB и Я.Маркет',
  'Перепиши описание: факты из карточки, без воды и капса',
];

function previewText(value, limit = 220) {
  const s = String(value || '').trim();
  if (!s) return '—';
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}…`;
}

function emptyHint(reason) {
  if (reason === 'all_filled') {
    return 'Все выбранные поля уже заполнены. Снимите галочку «Только пустые поля», чтобы модель переписала текст.';
  }
  return 'Модель не предложила изменений. Уточните запрос или снимите галочку «Только пустые поля».';
}

function DiffTable({ changes, emptyReason }) {
  if (!changes?.length) {
    return <p className="product-ai-draft__empty">{emptyHint(emptyReason)}</p>;
  }
  return (
    <div className="product-ai-draft__table-wrap">
      <table className="product-ai-draft__table">
        <thead>
          <tr>
            <th>Поле</th>
            <th>Сейчас</th>
            <th>Черновик</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => (
            <tr key={c.field}>
              <td>{c.label || c.field}</td>
              <td>{previewText(c.from)}</td>
              <td>{previewText(c.to)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProductAiDraftModal({
  isOpen,
  onClose,
  mode = 'single',
  productId = null,
  getDraft,
  bulkItems = [],
  onApply,
  onApplyBulk,
}) {
  const isBulk = mode === 'bulk';
  const [config, setConfig] = useState(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [instruction, setInstruction] = useState('');
  const [fields, setFields] = useState(() => [...AI_CARD_FIELD_KEYS]);
  const [fillEmptyOnly, setFillEmptyOnly] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const cappedBulk = useMemo(() => (Array.isArray(bulkItems) ? bulkItems.slice(0, MAX_BULK_AI_CARDS) : []), [bulkItems]);
  const skippedBulk = Math.max(0, (bulkItems?.length || 0) - cappedBulk.length);

  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    setConfigLoading(true);
    setError(null);
    setResult(null);
    setInstruction('');
    setFields([...AI_CARD_FIELD_KEYS]);
    setFillEmptyOnly(true);
    aiApi
      .getConfig()
      .then((data) => {
        if (!cancelled) setConfig(data);
      })
      .catch(() => {
        if (!cancelled) setConfig({ configured: false });
      })
      .finally(() => {
        if (!cancelled) setConfigLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const ready = !!(config?.configured && config?.enabled);

  const toggleField = (key) => {
    setFields((prev) => {
      if (prev.includes(key)) {
        const next = prev.filter((k) => k !== key);
        return next.length ? next : prev;
      }
      return [...prev, key];
    });
  };

  const generate = async () => {
    if (loading || !ready) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      if (isBulk) {
        if (!cappedBulk.length) {
          throw new Error('Выберите товары в таблице — не больше 8 за раз');
        }
        const data = await aiApi.proposeProductCardsBulk({
          items: cappedBulk,
          instruction,
          fields,
          fillEmptyOnly,
        });
        setResult(data);
      } else {
        const draft = typeof getDraft === 'function' ? getDraft() : {};
        const data = await aiApi.proposeProductCard({
          productId: productId || undefined,
          draft,
          instruction,
          fields,
          fillEmptyOnly,
        });
        setResult(data);
      }
    } catch (err) {
      setError(getApiErrorMessage(err, 'Не удалось собрать черновик карточки'));
    } finally {
      setLoading(false);
    }
  };

  const apply = () => {
    if (isBulk) {
      const items = result?.items || [];
      if (!items.length) return;
      onApplyBulk?.(items);
    } else if (result?.proposed && Object.keys(result.proposed).length) {
      onApply?.(result.proposed, result);
    }
    onClose?.();
  };

  const canApply = isBulk
    ? (result?.items || []).some((it) => it?.changes?.length)
    : !!(result?.changes?.length);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isBulk ? 'Черновик карточек (ИИ)' : 'Черновик карточки (ИИ)'}
      size="xl"
      scrollable
      closeOnBackdropClick={!loading}
    >
      <div className="product-ai-draft">
        <p className="product-ai-draft__hint">
          GigaChat предлагает названия и описания. Превью можно править у себя в форме или таблице.
          В ERP и на маркетплейсы ничего не уходит, пока вы не нажмёте «Сохранить».
        </p>

        {configLoading ? (
          <p className="product-ai-draft__hint">Проверяю подключение GigaChat…</p>
        ) : !ready ? (
          <p className="product-ai-draft__hint">
            Подключите GigaChat в{' '}
            <Link to="/integrations?tab=other&id=gigachat">Интеграции → Остальное → GigaChat</Link>.
          </p>
        ) : (
          <>
            {isBulk ? (
              <p className="product-ai-draft__meta">
                Товаров в запросе: {cappedBulk.length}
                {skippedBulk > 0 ? ` (ещё ${skippedBulk} не вошли — лимит ${MAX_BULK_AI_CARDS})` : ''}
              </p>
            ) : null}

            <label className="product-ai-draft__label" htmlFor="product-ai-instruction">
              Что сделать
            </label>
            <textarea
              id="product-ai-instruction"
              className="product-ai-draft__textarea"
              rows={3}
              maxLength={2000}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Можно оставить пустым — заполним пустые названия и описания по карточке"
              disabled={loading}
            />
            <div className="product-ai-draft__examples">
              {EXAMPLES.map((q) => (
                <button
                  key={q}
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    setInstruction(q);
                    setFillEmptyOnly(/пуст/.test(q.toLowerCase()) && !/перепиш|сделай|продающ/.test(q.toLowerCase()));
                  }}
                >
                  {q}
                </button>
              ))}
            </div>

            <div className="product-ai-draft__fields">
              {AI_CARD_FIELDS.map((f) => (
                <label key={f.key} className="product-ai-draft__check">
                  <input
                    type="checkbox"
                    checked={fields.includes(f.key)}
                    onChange={() => toggleField(f.key)}
                    disabled={loading}
                  />
                  {f.label}
                </label>
              ))}
            </div>
            <label className="product-ai-draft__check product-ai-draft__check--block">
              <input
                type="checkbox"
                checked={fillEmptyOnly}
                onChange={(e) => setFillEmptyOnly(e.target.checked)}
                disabled={loading}
              />
              Только пустые поля — не переписывать уже заполненное
            </label>
            {fillEmptyOnly && instructionAllowsOverwrite(instruction) ? (
              <p className="product-ai-draft__meta">
                В запросе просят заполнить или переписать текст — модель сможет менять уже заполненные поля.
              </p>
            ) : null}

            {error ? <div className="product-ai-draft__error">{error}</div> : null}

            <div className="product-ai-draft__actions">
              <Button type="button" variant="primary" size="small" onClick={generate} disabled={loading}>
                {loading ? 'Собираю черновик…' : 'Собрать черновик'}
              </Button>
              {result?.comment ? <span className="product-ai-draft__comment">{result.comment}</span> : null}
            </div>

            {result && !isBulk ? (
              <>
                {(result.warnings || []).length ? (
                  <p className="product-ai-draft__warn">{result.warnings.join(' ')}</p>
                ) : null}
                <DiffTable changes={result.changes} emptyReason={result.emptyReason} />
              </>
            ) : null}

            {result && isBulk ? (
              <div className="product-ai-draft__bulk-list">
                {(result.items || []).map((it, idx) => (
                  <details key={`${it.productId || it.sku || idx}`} open={idx === 0}>
                    <summary>
                      {it.sku || `Товар ${it.productId || idx + 1}`}
                      {it.changes?.length ? ` · ${it.changes.length} полей` : ' · без изменений'}
                    </summary>
                    {it.comment ? <p className="product-ai-draft__comment">{it.comment}</p> : null}
                    <DiffTable changes={it.changes} emptyReason={it.emptyReason || result.emptyReason} />
                  </details>
                ))}
              </div>
            ) : null}

            <div className="product-ai-draft__footer">
              <Button type="button" variant="secondary" size="small" onClick={onClose} disabled={loading}>
                Закрыть
              </Button>
              <Button type="button" variant="primary" size="small" onClick={apply} disabled={loading || !canApply}>
                {isBulk ? 'Подставить в таблицу' : 'Подставить в форму'}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
