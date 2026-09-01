import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { chestnyZnakApi } from '../../services/chestnyZnak.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import { createDetachedCadesBes, listCryptoProCertificates } from '../../utils/cryptoProSign.js';
import { CHESTNY_ZNAK_OPERATIONS, CHESTNY_ZNAK_PRODUCT_GROUPS } from '../Integrations/chestnyZnakGroups';
import { useChestnyZnakEnabled } from '../../hooks/useChestnyZnakEnabled.js';
import '../Integrations/Integrations.css';

const STATUS_RU = {
  scanned: 'Отсканирован',
  in_stock: 'На балансе',
  reserved: 'В документе',
  transferred: 'Передан',
  withdrawn: 'Выведен',
  error: 'Ошибка',
  draft: 'Черновик',
  ready: 'К отправке',
  edo_pending: 'Ждёт УПД в ЭДО',
  edo_done: 'УПД подписан',
  sent: 'Отправлен в ГИС МТ',
  accepted: 'Принят',
  rejected: 'Отклонён',
};

export function ChestnyZnakMarking() {
  const { enabled: chestnyZnakEnabled, loading: chestnyLoading } = useChestnyZnakEnabled();
  const [config, setConfig] = useState(null);
  const [kind, setKind] = useState('own_use');
  const [pg, setPg] = useState('tires');
  const [scan, setScan] = useState('');
  const [sessionIds, setSessionIds] = useState([]);
  const [registry, setRegistry] = useState([]);
  const [docs, setDocs] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [certs, setCerts] = useState([]);
  const [thumbprint, setThumbprint] = useState('');

  const enabledOps = useMemo(() => {
    const ops = config?.operations || {};
    const list = config?.operationOptions?.length ? config.operationOptions : CHESTNY_ZNAK_OPERATIONS;
    return list.filter((o) => ops[o.id] !== false);
  }, [config]);

  const load = useCallback(async () => {
    const [cfg, cis, documents] = await Promise.all([
      chestnyZnakApi.getConfig(),
      chestnyZnakApi.listCis({ limit: 200 }),
      chestnyZnakApi.listDocuments({ limit: 80 }),
    ]);
    setConfig(cfg || {});
    setRegistry(cis?.items || []);
    setDocs(documents?.items || []);
    if (cfg?.product_groups?.[0]) setPg(cfg.product_groups[0]);
    if (cfg?.cert_thumbprint) setThumbprint(cfg.cert_thumbprint);
  }, []);

  useEffect(() => {
    if (chestnyLoading || !chestnyZnakEnabled) return undefined;
    load().catch((err) => setError(getApiErrorMessage(err, 'Не удалось загрузить журнал маркировки')));
    return undefined;
  }, [load, chestnyLoading, chestnyZnakEnabled]);

  useEffect(() => {
    if (enabledOps.length && !enabledOps.some((o) => o.id === kind)) {
      setKind(enabledOps[0].id);
    }
  }, [enabledOps, kind]);

  const handleScan = async (e) => {
    e?.preventDefault?.();
    const code = String(scan || '').trim();
    if (!code) return;
    setBusy(true);
    setError(null);
    try {
      const data = await chestnyZnakApi.scanCis({ cis: code, product_group: pg });
      const item = data?.item;
      if (item?.id) {
        setSessionIds((prev) => (prev.includes(item.id) ? prev : [...prev, item.id]));
      }
      setScan('');
      if (data?.gis && data.gis.ok === false) {
        setNotice(data.gis.error_message || 'ГИС МТ не подтвердила код, в реестре он помечен ошибкой');
      }
      await load();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Не удалось отсканировать КИ'));
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const doc = await chestnyZnakApi.createDocument({
        kind,
        cis_ids: sessionIds,
        product_group: pg,
      });
      setSessionIds([]);
      setNotice(`Документ №${doc.id} создан (${STATUS_RU[doc.status] || doc.status})`);
      await load();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Не удалось создать документ'));
    } finally {
      setBusy(false);
    }
  };

  const copyCises = async (doc) => {
    const text = (doc.cises || []).map((c) => c.cis).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Коды скопированы — вставьте их в УПД оператора ЭДО');
    } catch {
      setNotice(text);
    }
  };

  const handleEdoDone = async (id) => {
    setBusy(true);
    setError(null);
    try {
      await chestnyZnakApi.markEdoDone(id);
      setNotice('УПД отмечен как подписанный, статусы КИ обновлены');
      await load();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Не удалось отметить УПД'));
    } finally {
      setBusy(false);
    }
  };

  const loadCerts = async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await listCryptoProCertificates();
      setCerts(list);
      if (!thumbprint && list.length) {
        const preferred = list.find((c) => !c.expired) || list[0];
        setThumbprint(preferred.thumbprint);
      }
    } catch (err) {
      setError(err?.message || 'Не удалось прочитать сертификаты');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (id) => {
    if (!thumbprint) {
      setError('Выберите сертификат УКЭП для подписи документа');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = await chestnyZnakApi.signingPayload(id);
      const signature = await createDetachedCadesBes(thumbprint, payload.to_sign);
      await chestnyZnakApi.submitDocument(id, signature);
      setNotice('Документ отправлен в ГИС МТ');
      await load();
    } catch (err) {
      setError(getApiErrorMessage(err, err?.message || 'Не удалось отправить документ'));
    } finally {
      setBusy(false);
    }
  };

  const sessionRows = registry.filter((r) => sessionIds.includes(Number(r.id)));
  const groups = config?.productGroupOptions?.length ? config.productGroupOptions : CHESTNY_ZNAK_PRODUCT_GROUPS;

  if (chestnyLoading) return null;
  if (!chestnyZnakEnabled) {
    return <Navigate to="/stock-levels/warehouse" replace />;
  }

  return (
    <div className="chestny-tab">
      <p className="chestny-hint">
        Журнал текущей организации (как Ozon/WB: свой кабинет на фирму).
        Настройка схем — в <Link to="/integrations">Интеграции → Честный знак</Link>.
      </p>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="chestny-notice">{notice}</div>}

      <div className="chestny-block">
        <h3>Сканирование и документ</h3>
        <div className="chestny-row">
          <div className="field">
            <label className="label">Схема</label>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
              {enabledOps.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label">Товарная группа</label>
            <select className="input" value={pg} onChange={(e) => setPg(e.target.value)}>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>
        </div>
        <form onSubmit={handleScan} className="chestny-row" style={{ alignItems: 'end' }}>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label className="label">Скан КИ</label>
            <input
              className="input"
              value={scan}
              onChange={(e) => setScan(e.target.value)}
              placeholder="Отсканируйте Data Matrix и Enter"
              autoComplete="off"
            />
          </div>
        </form>
        {sessionRows.length > 0 && (
          <p className="chestny-hint">В текущем документе: {sessionRows.length} КИ</p>
        )}
        <div className="form-actions">
          <Button type="button" variant="primary" onClick={handleCreate} disabled={busy || sessionIds.length === 0}>
            Создать документ
          </Button>
          <Button type="button" variant="secondary" onClick={() => setSessionIds([])} disabled={!sessionIds.length}>
            Очистить набор
          </Button>
        </div>
      </div>

      <div className="chestny-block">
        <h3>Документы организации</h3>
        <div className="form-actions" style={{ marginBottom: 8 }}>
          <Button type="button" variant="secondary" onClick={loadCerts} disabled={busy}>
            Сертификаты УКЭП
          </Button>
          {certs.length > 0 && (
            <select className="input" value={thumbprint} onChange={(e) => setThumbprint(e.target.value)} style={{ maxWidth: 360 }}>
              <option value="">— сертификат для отправки в ГИС МТ —</option>
              {certs.map((c) => (
                <option key={c.thumbprint} value={c.thumbprint} disabled={c.expired}>
                  {c.name}{c.expired ? ' (истёк)' : ''}
                </option>
              ))}
            </select>
          )}
        </div>
        {docs.length === 0 ? (
          <p className="chestny-hint">Документов пока нет.</p>
        ) : (
          <div className="chestny-cis-table-wrap">
            <table className="chestny-cis-table">
              <thead>
                <tr>
                  <th>№</th>
                  <th>Схема</th>
                  <th>Статус</th>
                  <th>КИ</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {docs.map((doc) => {
                  const op = CHESTNY_ZNAK_OPERATIONS.find((o) => o.id === doc.doc_kind);
                  return (
                    <tr key={doc.id}>
                      <td>{doc.id}</td>
                      <td>{op?.name || doc.doc_kind}</td>
                      <td>{STATUS_RU[doc.status] || doc.status}</td>
                      <td>{(doc.cises || []).length}</td>
                      <td>
                        <div className="form-actions" style={{ margin: 0 }}>
                          {doc.channel === 'edo' && (
                            <>
                              <Button type="button" variant="secondary" onClick={() => copyCises(doc)}>Коды для УПД</Button>
                              {doc.status === 'edo_pending' && (
                                <Button type="button" variant="primary" onClick={() => handleEdoDone(doc.id)} disabled={busy}>
                                  УПД подписан
                                </Button>
                              )}
                            </>
                          )}
                          {doc.channel === 'true_api' && (doc.status === 'ready' || doc.status === 'rejected') && (
                            <Button type="button" variant="primary" onClick={() => handleSubmit(doc.id)} disabled={busy}>
                              Подписать и отправить
                            </Button>
                          )}
                        </div>
                        {doc.error_message && <span className="chestny-hint">{doc.error_message}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="chestny-block">
        <h3>Реестр КИ</h3>
        {registry.length === 0 ? (
          <p className="chestny-hint">Пусто. Отсканируйте коды сверху.</p>
        ) : (
          <div className="chestny-cis-table-wrap">
            <table className="chestny-cis-table">
              <thead>
                <tr>
                  <th>КИ</th>
                  <th>Статус</th>
                  <th>ГИС МТ</th>
                  <th>GTIN</th>
                </tr>
              </thead>
              <tbody>
                {registry.map((row) => (
                  <tr key={row.id}>
                    <td className="chestny-mono">{row.cis}</td>
                    <td>{STATUS_RU[row.status] || row.status}</td>
                    <td>{row.gis_status || '—'}</td>
                    <td className="chestny-mono">{row.gtin || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
