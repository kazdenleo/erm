/**
 * Страница массового обогащения товаров (PartsIndex + маркетплейсы).
 * Вход: Товары → кнопка «Обогащение» в шапке (если модуль включён системным админом).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageTitle } from '../../components/layout/PageTitle/PageTitle';
import { Button } from '../../components/common/Button/Button';
import { useAuth } from '../../context/AuthContext.jsx';
import { isProfileProductEnrichmentEnabled } from '../../utils/profileFlags.js';
import { productsApi } from '../../services/products.api.js';
import { profilesApi } from '../../services/profiles.api.js';
import {
  emptyPartsIndexKeysForm,
  partsIndexKeysFromProfile,
} from '../../constants/partsindexKeys.js';
import './ProductEnrichment.css';

/**
 * Разбор строк: brand;sku | brand\tsku | brand,sku | brand sku
 * @param {string} text
 * @returns {{ brand: string, sku: string }[]}
 */
function parseBrandSkuList(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const items = [];
  for (const line of lines) {
    if (/^(бренд|brand)\s*[;,\t]/i.test(line) && /артикул|sku|number/i.test(line)) {
      continue; // заголовок
    }
    let brand = '';
    let sku = '';
    if (line.includes(';')) {
      const parts = line.split(';').map((p) => p.trim());
      brand = parts[0] || '';
      sku = parts[1] || '';
    } else if (line.includes('\t')) {
      const parts = line.split('\t').map((p) => p.trim());
      brand = parts[0] || '';
      sku = parts[1] || '';
    } else if (line.includes(',')) {
      const parts = line.split(',').map((p) => p.trim());
      brand = parts[0] || '';
      sku = parts[1] || '';
    } else {
      const parts = line.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        brand = parts[0];
        sku = parts.slice(1).join(' ');
      } else {
        sku = parts[0] || '';
      }
    }
    if (brand || sku) items.push({ brand, sku });
  }
  return items;
}

export function ProductEnrichment() {
  const navigate = useNavigate();
  const { profile, isTenantAccountAdmin, refreshUser } = useAuth();
  const flagEnabled = isProfileProductEnrichmentEnabled(profile);
  const [statusEnabled, setStatusEnabled] = useState(null);
  const enabled = statusEnabled === true || (statusEnabled == null && flagEnabled);
  /** Ключ PartsIndex — только администратор аккаунта (не системный admin платформы). */
  const canEditKeys = isTenantAccountAdmin;

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keys, setKeys] = useState(() => emptyPartsIndexKeysForm());
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysSaving, setKeysSaving] = useState(false);
  const [keysMessage, setKeysMessage] = useState('');
  const [keysError, setKeysError] = useState('');
  const [moduleInfo, setModuleInfo] = useState(null);

  const [listText, setListText] = useState('');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState('');
  const [report, setReport] = useState(null);

  const parsedItems = useMemo(() => parseBrandSkuList(listText), [listText]);

  const reloadStatus = useCallback(async () => {
    try {
      const res = await productsApi.enrichmentStatus();
      const data = res?.data ?? res;
      setModuleInfo(data);
      if (typeof data?.enabled === 'boolean') setStatusEnabled(data.enabled);
    } catch {
      setModuleInfo(null);
      setStatusEnabled(null);
    }
  }, []);

  useEffect(() => {
    reloadStatus();
  }, [reloadStatus]);

  useEffect(() => {
    if (!canEditKeys || !settingsOpen) return;
    let cancelled = false;
    (async () => {
      setKeysLoading(true);
      setKeysError('');
      try {
        const res = await profilesApi.getMe();
        if (cancelled) return;
        setKeys(
          partsIndexKeysFromProfile(res?.data?.partsindex_keys ?? res?.data?.partsindexKeys)
        );
      } catch (err) {
        if (!cancelled) {
          setKeysError(err?.response?.data?.message || err?.message || 'Не удалось загрузить ключ');
        }
      } finally {
        if (!cancelled) setKeysLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canEditKeys, settingsOpen]);

  const saveKeys = async () => {
    if (!canEditKeys) return;
    setKeysSaving(true);
    setKeysError('');
    setKeysMessage('');
    try {
      const res = await profilesApi.updateMe({
        partsindex_keys: partsIndexKeysFromProfile(keys),
      });
      if (!res?.ok) throw new Error(res?.message || 'Ошибка сохранения');
      setKeys(partsIndexKeysFromProfile(res?.data?.partsindex_keys ?? keys));
      setKeysMessage('Ключ сохранён');
      await refreshUser?.();
      await reloadStatus();
    } catch (err) {
      setKeysError(err?.response?.data?.message || err?.message || 'Ошибка сохранения ключа');
    } finally {
      setKeysSaving(false);
    }
  };

  const runEnrichment = async () => {
    const items = parseBrandSkuList(listText);
    if (!items.length) {
      setRunError('Добавьте хотя бы одну строку: бренд и артикул');
      return;
    }
    setRunning(true);
    setRunError('');
    setReport(null);
    try {
      const res = await productsApi.enrichBulk(items, { apply: false });
      setReport(res?.data ?? res);
      await reloadStatus();
    } catch (err) {
      setRunError(err?.response?.data?.message || err?.message || 'Ошибка обогащения');
    } finally {
      setRunning(false);
    }
  };

  if (!enabled) {
    return (
      <div className="product-enrichment-page">
        <PageTitle
          iconClass="pe-7s-magic-wand"
          iconBgClass="bg-mean-fruit"
          title="Обогащение"
          subtitle="Модуль обогащения карточек через PartsIndex"
        />
        <div className="card product-enrichment-card">
          <p className="mb-0">
            Модуль не включён для этого аккаунта. Системный администратор включает его в админке
            платформы (Аккаунты → колонка «Обогащение»), затем администратор аккаунта открывает
            Товары → Обогащение и задаёт API-ключ PartsIndex.
          </p>
        </div>
      </div>
    );
  }

  const missingKey = !moduleInfo?.configured && (moduleInfo?.missingMethods || []).includes('apiKey');

  return (
    <div className="product-enrichment-page">
      <PageTitle
        iconClass="pe-7s-magic-wand"
        iconBgClass="bg-mean-fruit"
        title="Обогащение"
        subtitle="Список бренд + артикул → сбор контента из PartsIndex. Товары в каталоге пока не создаются."
        actions={
          <>
            <Button
              type="button"
              className="btn-shadow me-2"
              variant="secondary"
              size="small"
              onClick={() => navigate('/products')}
            >
              К списку товаров
            </Button>
            <Button
              type="button"
              className="btn-shadow"
              variant="secondary"
              size="small"
              onClick={() => setSettingsOpen((v) => !v)}
            >
              {settingsOpen ? 'Скрыть настройки' : 'Настройки'}
            </Button>
          </>
        }
      />

      <div className="card product-enrichment-card">
        {settingsOpen && (
          <section className="product-enrichment-settings">
            <h2 className="h6 mb-1">API-ключ PartsIndex</h2>
            <p className="text-muted small mb-3">
              Ключ из кабинета{' '}
              <a href="https://api.parts-index.com/docs/ru/#/" target="_blank" rel="noreferrer">
                PartsIndex
              </a>
              . Передаётся в заголовке Authorization. Для полного обогащения на ключе нужны scopes:{' '}
              <code>access</code>, <code>info</code> (карточка), <code>relations</code> (аналоги),{' '}
              <code>old-apply</code> (применимость /cars). Хранится у аккаунта.
            </p>
            {!canEditKeys ? (
              <p className="text-muted small mb-0">
                Ключ задаёт администратор аккаунта. Войдите под пользователем аккаунта (не системным
                admin платформы) — тогда здесь появится поле для ввода.
              </p>
            ) : keysLoading ? (
              <p className="text-muted small">Загрузка…</p>
            ) : (
              <div className="product-enrichment-keys">
                <label className="d-block mb-2">
                  <span className="text-muted small d-block mb-1">API Key</span>
                  <input
                    type="text"
                    className="form-control form-control-sm"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Ключ PartsIndex"
                    value={keys.apiKey || ''}
                    onChange={(e) => setKeys({ apiKey: e.target.value })}
                  />
                </label>
                <div className="d-flex gap-2 align-items-center flex-wrap mt-2">
                  <Button
                    type="button"
                    variant="primary"
                    size="small"
                    onClick={saveKeys}
                    disabled={keysSaving}
                  >
                    {keysSaving ? 'Сохранение…' : 'Сохранить ключ'}
                  </Button>
                  {keysMessage && <span className="small">{keysMessage}</span>}
                </div>
                {keysError && <div className="error mt-2">{keysError}</div>}
              </div>
            )}
          </section>
        )}

        {missingKey && !settingsOpen && (
          <div className="product-enrichment-hint text-muted small">
            Нет API-ключа PartsIndex. Откройте «Настройки» и вставьте ключ.
          </div>
        )}

        <section className="product-enrichment-list">
          <label className="d-block mb-1" htmlFor="enrichment-list">
            <strong>Список для сбора контента</strong>
            <span
              className="text-muted small"
              style={{ display: 'block', fontWeight: 'normal', marginTop: 4 }}
            >
              Одна позиция на строку: <code>бренд;артикул</code> (также таб, запятая или пробел).
              Собираем PartsIndex: карточка (<code>/v1/entities</code>), аналоги (
              <code>/v1/relations</code>), применимость (<code>/v1/cars</code>) — и при
              необходимости дополняем с Ozon / Wildberries / Яндекс.Маркет. Нужны scopes ключа:{' '}
              <code>access</code>, <code>info</code>, <code>relations</code>,{' '}
              <code>old-apply</code>. Карточки ERP не создаются — только просмотр.
            </span>
          </label>
          <textarea
            id="enrichment-list"
            className="form-control"
            rows={8}
            value={listText}
            onChange={(e) => setListText(e.target.value)}
            placeholder={'Вставьте список сюда, например:\nZekkert;TG-5127\nBosch;0986424590'}
            spellCheck={false}
          />
          <div className="product-enrichment-actions">
            <span className="text-muted small">
              {parsedItems.length > 0
                ? `Строк: ${parsedItems.length}`
                : 'Список пуст — введите или вставьте бренд;артикул'}
            </span>
            <Button
              type="button"
              variant="primary"
              onClick={runEnrichment}
              disabled={running || !parsedItems.length}
              title={
                !parsedItems.length
                  ? 'Сначала введите хотя бы одну строку бренд;артикул'
                  : undefined
              }
            >
              {running ? 'Сбор…' : 'Собрать контент'}
            </Button>
          </div>
          {runError && <div className="error mt-2">{runError}</div>}
        </section>

        {report && (
          <section className="product-enrichment-report">
            <h2 className="h6">
              Результат: успешно {report.ok ?? 0} / {report.total ?? 0}
              {report.failed ? `, ошибок ${report.failed}` : ''}
            </h2>
            <div className="product-enrichment-cards">
              {(report.results || []).map((row) => {
                const c = row.content || {};
                const partsImages = (c.images || []).map((x) =>
                  typeof x === 'string'
                    ? { url: x, source: 'partsindex' }
                    : { ...x, source: x.source || 'partsindex' }
                );
                const mpImages = (c.marketplaceImages || []).map((x) =>
                  typeof x === 'string' ? { url: x } : x
                );
                const mp = c.marketplace || {};
                const mpKeys = ['ozon', 'wb', 'ym'];
                const mpTitles = {
                  ozon: 'Ozon',
                  wb: 'Wildberries',
                  ym: 'Яндекс.Маркет',
                  erp: 'ERP',
                };
                return (
                  <article key={`${row.index}-${row.sku}`} className="product-enrichment-item">
                    <header className="product-enrichment-item__head">
                      <div>
                        <strong>
                          {row.brand || '—'} · {row.sku || '—'}
                        </strong>
                        {row.matchedBrand || row.matchedNumber ? (
                          <span className="text-muted small" style={{ marginLeft: 8 }}>
                            PartsIndex:{' '}
                            {[row.matchedBrand, row.matchedNumber].filter(Boolean).join(' / ')}
                            {row.entityId || row.artId
                              ? ` · id ${row.entityId || row.artId}`
                              : ''}
                          </span>
                        ) : null}
                        {row.erpProductId ? (
                          <span className="text-muted small" style={{ marginLeft: 8 }}>
                            ERP #{row.erpProductId}
                          </span>
                        ) : null}
                      </div>
                      {row.ok ? (
                        <span className="badge bg-success">{row.status || 'ok'}</span>
                      ) : (
                        <span className="badge bg-danger">ошибка</span>
                      )}
                    </header>

                    {!row.ok ? (
                      <div>
                        <p className="mb-1 small text-danger">{row.error || 'Ошибка'}</p>
                        {row.warnings?.length ? (
                          <p className="mb-0 small text-muted">
                            Детали: {row.warnings.join(' · ')}
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <div className="product-enrichment-item__body">
                        {row.methodsUsed?.length ? (
                          <div className="text-muted small">
                            Источники: {row.methodsUsed.join(', ')}
                            {row.filled?.length ? ` · поля: ${row.filled.join(', ')}` : ''}
                          </div>
                        ) : null}

                        {partsImages.length ? (
                          <div>
                            <div className="text-muted small mb-1">
                              Фото PartsIndex ({partsImages.length})
                            </div>
                            <div className="product-enrichment-images">
                              {partsImages.map((img) => (
                                <a
                                  key={`p-${img.url}`}
                                  href={img.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  title={img.kind || ''}
                                >
                                  <img src={img.url} alt="" loading="lazy" />
                                </a>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        {mpImages.length ? (
                          <div>
                            <div className="text-muted small mb-1">
                              Фото маркетплейсов ({mpImages.length})
                            </div>
                            <div className="product-enrichment-images">
                              {mpImages.map((img) => (
                                <a
                                  key={`m-${img.source || 'x'}-${img.url}`}
                                  href={img.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  title={mpTitles[img.source] || img.kind || img.source || ''}
                                  className="product-enrichment-images__mp"
                                  data-mp={img.source || ''}
                                >
                                  <img src={img.url} alt="" loading="lazy" />
                                  {(img.source || img.kind) && (
                                    <span className="product-enrichment-images__badge">
                                      {mpTitles[img.source] || img.kind || img.source}
                                    </span>
                                  )}
                                </a>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        <div className="product-enrichment-fields">
                          <div>
                            <div className="text-muted small">Название</div>
                            <div>{c.name || row.name || '—'}</div>
                          </div>
                          <div className="product-enrichment-dims">
                            <div>
                              <div className="text-muted small">Вес</div>
                              <div>{c.weight != null ? `${c.weight} г` : '—'}</div>
                            </div>
                            <div>
                              <div className="text-muted small">Д×Ш×В</div>
                              <div>
                                {[c.length, c.width, c.height].every((v) => v == null)
                                  ? '—'
                                  : `${c.length ?? '—'} × ${c.width ?? '—'} × ${c.height ?? '—'} мм`}
                              </div>
                            </div>
                            <div>
                              <div className="text-muted small">Штрихкоды</div>
                              <div>{c.barcodes?.length ? c.barcodes.join(', ') : '—'}</div>
                            </div>
                          </div>
                          {c.oemNumbers?.length ? (
                            <div>
                              <div className="text-muted small">OEM / кроссы</div>
                              <div className="small">{c.oemNumbers.join(', ')}</div>
                            </div>
                          ) : null}
                          {c.analogs?.length ? (
                            <div>
                              <div className="text-muted small">
                                Аналоги / связи PartsIndex · /v1/relations ({c.analogs.length})
                              </div>
                              <ul className="mb-0 small ps-3">
                                {c.analogs.slice(0, 40).map((a, idx) => (
                                  <li key={`${a.id || a.code || idx}-${a.brand || ''}`}>
                                    {[a.brand, a.code].filter(Boolean).join(' ')}
                                    {a.relation ? (
                                      <span className="text-muted"> · {a.relation}</span>
                                    ) : null}
                                  </li>
                                ))}
                              </ul>
                              {c.analogs.length > 40 ? (
                                <div className="small text-muted">…ещё {c.analogs.length - 40}</div>
                              ) : null}
                            </div>
                          ) : null}
                          {c.applicability?.length ? (
                            <div>
                              <div className="text-muted small">
                                Применимость · /v1/cars ({c.applicability.length})
                              </div>
                              <ul className="mb-0 small ps-3">
                                {c.applicability.slice(0, 50).map((a, idx) => {
                                  const power = [
                                    a.hp != null ? `${a.hp} л.с.` : null,
                                    a.kw != null ? `${a.kw} кВт` : null,
                                    a.cc != null ? `${a.cc} см³` : null,
                                  ]
                                    .filter(Boolean)
                                    .join(', ');
                                  return (
                                    <li key={`${a.brand}-${a.model}-${a.modif}-${idx}`}>
                                      {[a.brand, a.model, a.modif].filter(Boolean).join(' ')}
                                      {a.years ? (
                                        <span className="text-muted"> · {a.years}</span>
                                      ) : null}
                                      {a.body ? (
                                        <span className="text-muted"> · {a.body}</span>
                                      ) : null}
                                      {a.engCode ? (
                                        <span className="text-muted"> · дв. {a.engCode}</span>
                                      ) : null}
                                      {power ? (
                                        <span className="text-muted"> · {power}</span>
                                      ) : null}
                                    </li>
                                  );
                                })}
                              </ul>
                              {c.applicability.length > 50 ? (
                                <div className="small text-muted">
                                  …ещё {c.applicability.length - 50}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                          <div>
                            <div className="text-muted small">
                              Описание / характеристики
                              {c.attributes?.length ? ` (${c.attributes.length})` : ''}
                            </div>
                            <pre className="product-enrichment-desc">
                              {c.description ||
                                (c.attributes?.length
                                  ? c.attributes.map((a) => `${a.name}: ${a.value}`).join('\n')
                                  : '—')}
                            </pre>
                          </div>

                          {mpKeys.some(
                            (k) => mp[k]?.ok || mp[k]?.name || mp[k]?.description || mp[k]?.error
                          ) ? (
                            <div className="product-enrichment-mp">
                              <div className="text-muted small mb-1">Карточки маркетплейсов</div>
                              <div className="product-enrichment-mp__grid">
                                {mpKeys.map((k) => {
                                  const block = mp[k] || {};
                                  return (
                                    <div key={k} className="product-enrichment-mp__card">
                                      <div className="product-enrichment-mp__title">
                                        {mpTitles[k]}
                                        {block.source ? (
                                          <span className="text-muted"> · {block.source}</span>
                                        ) : null}
                                        {!block.ok && block.error ? (
                                          <span className="text-danger"> · нет данных</span>
                                        ) : null}
                                      </div>
                                      {block.name ? (
                                        <div className="small">
                                          <strong>Название:</strong> {block.name}
                                        </div>
                                      ) : null}
                                      {block.description ? (
                                        <pre className="product-enrichment-desc">
                                          {block.description}
                                        </pre>
                                      ) : null}
                                      {!block.name && !block.description && block.error ? (
                                        <div className="small text-muted">{block.error}</div>
                                      ) : null}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ) : null}

                          {row.warnings?.length ? (
                            <div className="small text-muted">
                              Предупреждения: {row.warnings.join(' · ')}
                            </div>
                          ) : null}
                          {c.rawByMethod && Object.keys(c.rawByMethod).length ? (
                            <details className="product-enrichment-raw">
                              <summary className="small text-muted">Сырые ответы PartsIndex</summary>
                              <pre className="product-enrichment-desc">
                                {JSON.stringify(c.rawByMethod, null, 2)}
                              </pre>
                            </details>
                          ) : null}
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

export default ProductEnrichment;
