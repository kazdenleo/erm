/**
 * Модальное окно выбора поставок перед загрузкой (Excel или API).
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Modal } from '../../components/common/Modal/Modal';
import { Button } from '../../components/common/Button/Button';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { useAuth } from '../../context/AuthContext';
import { getMarketplaceLabel } from '../../constants/fboSupplyStatuses';
import './FboSupplies.css';

function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('ru-RU');
}

export function FboSupplyImportModal({ open, onClose, mode, organizationId: organizationIdProp, onImported }) {
  const { selectedOrganizationId } = useAuth();
  const organizationId =
    organizationIdProp != null && String(organizationIdProp).trim() !== ''
      ? organizationIdProp
      : selectedOrganizationId || null;

  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [marketplace, setMarketplace] = useState('ozon');
  const [daysBack, setDaysBack] = useState(90);

  const reset = useCallback(() => {
    setCandidates([]);
    setSelected(new Set());
    setErr(null);
    setLoading(false);
    setConfirming(false);
  }, []);

  const handleClose = () => {
    reset();
    onClose?.();
  };

  const selectable = useMemo(
    () => candidates.filter((c) => !c.alreadyImported),
    [candidates]
  );

  const toggleAll = (checked) => {
    if (checked) {
      setSelected(new Set(selectable.map((c) => c.importKey)));
    } else {
      setSelected(new Set());
    }
  };

  const toggleOne = (key) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const loadFromApi = async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await fboSuppliesApi.previewApiImport({
        marketplace,
        organizationId,
        daysBack,
      });
      const list = Array.isArray(data) ? data : [];
      setCandidates(list);
      setSelected(new Set(list.filter((c) => !c.alreadyImported).map((c) => c.importKey)));
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось получить поставки');
    } finally {
      setLoading(false);
    }
  };

  const loadFromExcel = async (file) => {
    if (!file) return;
    setLoading(true);
    setErr(null);
    try {
      const data = await fboSuppliesApi.previewExcelImport(file);
      const list = (Array.isArray(data) ? data : []).map((c) => ({
        ...c,
        importKey: c.importKey || `excel:${c.externalShipmentNumber}`,
        source: 'excel',
      }));
      setCandidates(list);
      setSelected(new Set(list.filter((c) => !c.alreadyImported).map((c) => c.importKey)));
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось разобрать Excel');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    const toImport =
      mode === 'excel' && candidates[0]?.isNewDraft
        ? candidates
        : candidates.filter((c) => selected.has(c.importKey));
    if (!toImport.length) {
      setErr(mode === 'excel' ? 'Нет данных для создания поставки' : 'Выберите хотя бы одну поставку');
      return;
    }
    setConfirming(true);
    setErr(null);
    try {
      const source = mode === 'excel' ? 'excel' : 'api';
      const result = await fboSuppliesApi.confirmImport(toImport, source);
      onImported?.(result);
      handleClose();
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось загрузить поставки');
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      title={mode === 'excel' ? 'Новая поставка из Excel' : 'Загрузка поставок с маркетплейса'}
      onClose={handleClose}
      size="large"
    >
      <div className="fbo-supplies-page">
        {mode === 'api' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12, alignItems: 'flex-end' }}>
            <div>
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Маркетплейс</label>
              <select
                className="form-select form-select-sm"
                value={marketplace}
                onChange={(e) => setMarketplace(e.target.value)}
              >
                <option value="ozon">Ozon</option>
                <option value="wb">Wildberries</option>
                <option value="ym">Яндекс Маркет</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Период, дней</label>
              <input
                type="number"
                className="form-control form-control-sm"
                style={{ width: 100 }}
                min={7}
                max={365}
                value={daysBack}
                onChange={(e) => setDaysBack(e.target.value)}
              />
            </div>
            <Button variant="primary" onClick={loadFromApi} disabled={loading}>
              {loading ? 'Загрузка…' : 'Получить список'}
            </Button>
          </div>
        )}
        {mode === 'api' && !organizationId ? (
          <p className="text-muted small mb-2">
            Выберите организацию в шапке сайта — ключи маркетплейса задаются в «Интеграции» для каждой
            организации.
          </p>
        ) : null}
        {mode === 'api' && marketplace === 'wb' ? (
          <p className="text-muted small mb-2">
            Wildberries: поставки на склад WB (FBW). Нужен API-токен категории «Поставки» в разделе
            «Интеграции».
          </p>
        ) : null}

        {mode === 'excel' && (
          <div style={{ marginBottom: 12 }}>
            <p className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
              В файле только <strong>артикул</strong> и <strong>количество</strong> (шаблон — кнопка «Шаблон Excel»).
              Будет создана новая поставка; маркетплейс, склад и номер отгрузки заполните в карточке.
            </p>
            <input
              type="file"
              accept=".xlsx"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) loadFromExcel(f);
                e.target.value = '';
              }}
              disabled={loading}
            />
          </div>
        )}

        {err && (
          <div className="alert alert-danger" style={{ marginBottom: 12 }}>
            {err}
          </div>
        )}

        {candidates.length > 0 && mode === 'excel' && candidates[0]?.isNewDraft && (
          <>
            <p style={{ fontSize: 14, marginBottom: 8 }}>
              Будет создана поставка «{candidates[0].name}» — {(candidates[0].items || []).length} поз.
            </p>
            <div className="fbo-import-table-wrap">
              <table className="fbo-import-table">
                <thead>
                  <tr>
                    <th>Артикул</th>
                    <th>Количество</th>
                    <th>В ERM</th>
                  </tr>
                </thead>
                <tbody>
                  {(candidates[0].items || []).map((it, idx) => (
                    <tr key={idx}>
                      <td>{it.sku || '—'}</td>
                      <td>{it.quantity}</td>
                      <td>
                        {it.unresolved ? (
                          <span className="fbo-import-warn">не найден</span>
                        ) : (
                          <span className="badge bg-light text-dark">OK</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <Button variant="secondary" onClick={handleClose}>
                Отмена
              </Button>
              <Button variant="primary" onClick={handleConfirm} disabled={confirming}>
                {confirming ? 'Создание…' : 'Создать поставку'}
              </Button>
            </div>
          </>
        )}

        {candidates.length > 0 && mode === 'api' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label style={{ fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={selectable.length > 0 && selected.size === selectable.length}
                  onChange={(e) => toggleAll(e.target.checked)}
                  style={{ marginRight: 6 }}
                />
                Выбрать все новые ({selectable.length})
              </label>
              <span className="muted" style={{ fontSize: 12 }}>
                Выбрано: {selected.size}
              </span>
            </div>
            <div className="fbo-import-table-wrap">
              <table className="fbo-import-table">
                <thead>
                  <tr>
                    <th style={{ width: 36 }} />
                    <th>Номер отгрузки</th>
                    <th>МП</th>
                    <th>Название</th>
                    <th>Дата</th>
                    <th>Склад МП</th>
                    <th>Товаров</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => {
                    const disabled = c.alreadyImported;
                    const unresolved = (c.items || []).filter((i) => i.unresolved).length;
                    return (
                      <tr
                        key={c.importKey}
                        className={disabled ? 'fbo-import-row-disabled' : ''}
                      >
                        <td>
                          <input
                            type="checkbox"
                            disabled={disabled}
                            checked={selected.has(c.importKey)}
                            onChange={() => toggleOne(c.importKey)}
                          />
                        </td>
                        <td>{c.externalShipmentNumber}</td>
                        <td>{getMarketplaceLabel(c.marketplace)}</td>
                        <td>{c.name || '—'}</td>
                        <td>{fmtDate(c.readyAt)}</td>
                        <td>{c.marketplaceWarehouseName || '—'}</td>
                        <td>
                          {(c.items || []).length || c.itemCount || 0}
                          {unresolved > 0 && (
                            <div className="fbo-import-warn">{unresolved} без привязки</div>
                          )}
                        </td>
                        <td>
                          {disabled ? (
                            <span className="badge bg-secondary">Уже в системе</span>
                          ) : (
                            <span className="badge bg-light text-dark">Новая</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <Button variant="secondary" onClick={handleClose}>
                Отмена
              </Button>
              <Button variant="primary" onClick={handleConfirm} disabled={confirming || !selected.size}>
                {confirming ? 'Загрузка…' : `Загрузить выбранные (${selected.size})`}
              </Button>
            </div>
          </>
        )}

        {!candidates.length && !loading && mode === 'api' && (
          <p className="muted" style={{ fontSize: 13 }}>
            Нажмите «Получить список», чтобы увидеть поставки с маркетплейса и выбрать, какие загрузить в систему.
          </p>
        )}
      </div>
    </Modal>
  );
}
