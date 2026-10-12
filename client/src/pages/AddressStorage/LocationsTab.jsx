/**
 * Справочник ячеек: фильтры, генератор, редактирование, массовые действия, этикетки, импорт закрепления.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { addressStorageApi, addressStorageError } from '../../services/addressStorage.api';
import { AssignProductModal } from './AssignProductModal';
import { LOCATION_TYPE_LABELS, downloadBlob, splitAddress, compareText } from './addressStorageUtils';

const PAGE = 300;
const LEVEL_HINTS = ['A-C', '01-10', '1-5', '1-4', '1-3', '1-2'];

function GenerateModal({ isOpen, onClose, warehouseId, settings, onDone }) {
  const [values, setValues] = useState([]);
  const [type, setType] = useState('storage');
  const [capacity, setCapacity] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (isOpen) {
      setValues(settings.levels.map(() => ''));
      setPreview(null);
      setError(null);
    }
  }, [isOpen, settings.levels]);

  const body = (dryRun) => ({ levels: values, type, capacity: capacity === '' ? null : Number(capacity), dryRun });

  const doPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await addressStorageApi.generateLocations(warehouseId, body(true)));
    } catch (e) {
      setError(addressStorageError(e).message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const doCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await addressStorageApi.generateLocations(warehouseId, body(false));
      await onDone?.(r);
      onClose();
    } catch (e) {
      setError(addressStorageError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Создать ячейки" size="medium">
      <p className="muted-hint mt-0">
        Для каждого уровня перечислите значения: диапазон <code>1-10</code>, с нулями <code>01-12</code>, буквы{' '}
        <code>A-D</code> или список <code>A,B,F</code>. Будут созданы все сочетания; существующие пропускаются.
      </p>
      <div className="address-generate">
        {settings.levels.map((l, i) => (
          <label key={i} className="address-generate__row">
            <span>{l.label}</span>
            <input
              className="form-control form-control-sm"
              value={values[i] ?? ''}
              placeholder={LEVEL_HINTS[i] || '1-3'}
              onChange={(e) => {
                setValues((v) => v.map((x, idx) => (idx === i ? e.target.value : x)));
                setPreview(null);
              }}
            />
          </label>
        ))}
        <label className="address-generate__row">
          <span>Тип</span>
          <select className="form-select form-select-sm" value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(LOCATION_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="address-generate__row">
          <span>Вместимость, шт</span>
          <input
            type="number"
            min={0}
            className="form-control form-control-sm"
            value={capacity}
            placeholder="не ограничена"
            onChange={(e) => setCapacity(e.target.value)}
          />
        </label>
      </div>
      {error ? <div className="alert alert-danger py-2">{error}</div> : null}
      {preview ? (
        <div className="address-generate__preview">
          Будет создано до <strong>{preview.total}</strong> ячеек:{' '}
          {preview.sample.map((c) => (
            <code key={c} className="address-code">
              {c}
            </code>
          ))}
          {preview.total > preview.sample.length ? ' …' : ''}
        </div>
      ) : null}
      <div className="address-modal__actions">
        <Button variant="secondary" onClick={doPreview} disabled={busy || values.some((v) => !v.trim())}>
          Предпросмотр
        </Button>
        <Button onClick={doCreate} disabled={busy || !preview}>
          {busy ? '…' : 'Создать'}
        </Button>
      </div>
    </Modal>
  );
}

function EditModal({ location, isNew, warehouseId, settings, onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!location && !isNew) return;
    setError(null);
    setForm(
      isNew
        ? { parts: settings.levels.map(() => ''), type: 'storage', capacity: '', routeOrder: '', barcode: '', note: '', isActive: true }
        : {
            parts: [...location.parts],
            type: location.type,
            capacity: location.capacity ?? '',
            routeOrder: location.routeOrder,
            barcode: location.barcode || '',
            note: location.note || '',
            isActive: location.isActive,
          }
    );
  }, [location, isNew, settings.levels]);

  if (!form) return null;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      parts: form.parts,
      type: form.type,
      capacity: form.capacity === '' ? null : Number(form.capacity),
      barcode: form.barcode.trim() || null,
      note: form.note.trim() || null,
      isActive: form.isActive,
    };
    if (form.routeOrder !== '') body.routeOrder = Number(form.routeOrder);
    try {
      if (isNew) await addressStorageApi.createLocation(warehouseId, body);
      else await addressStorageApi.updateLocation(warehouseId, location.id, body);
      await onSaved?.();
      onClose();
    } catch (e) {
      setError(addressStorageError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={isNew ? 'Новая ячейка' : `Ячейка ${location.code}`} size="medium">
      <div className="address-generate">
        <div className="address-generate__row">
          <span>Адрес</span>
          <div className="address-edit__parts">
            {settings.levels.map((l, i) => (
              <input
                key={i}
                className="form-control form-control-sm"
                title={l.label}
                placeholder={l.label}
                value={form.parts[i] ?? ''}
                onChange={(e) => set({ parts: form.parts.map((p, idx) => (idx === i ? e.target.value : p)) })}
              />
            ))}
          </div>
        </div>
        <label className="address-generate__row">
          <span>Тип</span>
          <select className="form-select form-select-sm" value={form.type} onChange={(e) => set({ type: e.target.value })}>
            {Object.entries(LOCATION_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="address-generate__row">
          <span>Вместимость, шт</span>
          <input
            type="number"
            min={0}
            className="form-control form-control-sm"
            value={form.capacity}
            placeholder="не ограничена"
            onChange={(e) => set({ capacity: e.target.value })}
          />
        </label>
        <label className="address-generate__row">
          <span>Порядок обхода</span>
          <input
            type="number"
            className="form-control form-control-sm"
            value={form.routeOrder}
            placeholder="в конец маршрута"
            onChange={(e) => set({ routeOrder: e.target.value })}
          />
        </label>
        <label className="address-generate__row">
          <span>Свой штрихкод</span>
          <input
            className="form-control form-control-sm"
            value={form.barcode}
            placeholder={isNew ? 'по умолчанию — адрес' : location.effectiveBarcode}
            onChange={(e) => set({ barcode: e.target.value })}
          />
        </label>
        <label className="address-generate__row">
          <span>Заметка</span>
          <input className="form-control form-control-sm" value={form.note} onChange={(e) => set({ note: e.target.value })} />
        </label>
        <label className="address-generate__row">
          <span>Активна</span>
          <input type="checkbox" checked={form.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
        </label>
      </div>
      {error ? <div className="alert alert-danger py-2">{error}</div> : null}
      <div className="address-modal__actions">
        <Button variant="secondary" onClick={onClose}>
          Отмена
        </Button>
        <Button onClick={save} disabled={busy}>
          {busy ? '…' : 'Сохранить'}
        </Button>
      </div>
    </Modal>
  );
}

function ImportModal({ isOpen, onClose, warehouseId, onDone }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (isOpen) {
      setResult(null);
      setError(null);
    }
  }, [isOpen]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await addressStorageApi.importAssignments(warehouseId, text);
      setResult(r);
      await onDone?.();
    } catch (e) {
      setError(addressStorageError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Импорт закрепления товаров" size="medium">
      <p className="muted-hint mt-0">
        По строке на товар: <code>артикул;адрес</code> (разделитель — точка с запятой, запятая или табуляция). Можно
        скопировать два столбца из Excel.
      </p>
      <textarea
        className="form-control form-control-sm address-import__text"
        rows={10}
        value={text}
        placeholder={'TG-5127;A-01-3-2\nTG-5404;A-01-3-3'}
        onChange={(e) => setText(e.target.value)}
      />
      {error ? <div className="alert alert-danger py-2 mt-2">{error}</div> : null}
      {result ? (
        <div className="mt-2">
          <div className="text-success">Закреплено товаров: {result.assigned}</div>
          {result.errorsTotal ? (
            <div className="address-import__errors">
              <div className="text-danger">Ошибок: {result.errorsTotal}</div>
              <ul>
                {result.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="address-modal__actions">
        <Button variant="secondary" onClick={onClose}>
          Закрыть
        </Button>
        <Button onClick={run} disabled={busy || !text.trim()}>
          {busy ? '…' : 'Импортировать'}
        </Button>
      </div>
    </Modal>
  );
}

export function LocationsTab({ warehouseId, settings, locations, locationsLoading, reloadLocations }) {
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [rackFilter, setRackFilter] = useState('');
  const [occupancy, setOccupancy] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState(() => new Set());
  const [genOpen, setGenOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [assignId, setAssignId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const sep = settings.separator;
  const rackKeys = useMemo(() => {
    const set = new Set(locations.map((l) => splitAddress(l.parts, sep).rackKey));
    return [...set].sort(compareText);
  }, [locations, sep]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return locations.filter((l) => {
      if (typeFilter && l.type !== typeFilter) return false;
      if (rackFilter && splitAddress(l.parts, sep).rackKey !== rackFilter) return false;
      const occupied = l.products.length > 0;
      if (occupancy === 'empty' && occupied) return false;
      if (occupancy === 'busy' && !occupied) return false;
      if (occupancy === 'inactive' && l.isActive) return false;
      if (!term) return true;
      if (l.code.toLowerCase().includes(term)) return true;
      return l.products.some(
        (p) => String(p.sku || '').toLowerCase().includes(term) || String(p.name || '').toLowerCase().includes(term)
      );
    });
  }, [locations, q, typeFilter, rackFilter, occupancy, sep]);

  useEffect(() => {
    setLimit(PAGE);
  }, [q, typeFilter, rackFilter, occupancy]);

  useEffect(() => {
    setSelected(new Set());
  }, [warehouseId]);

  const selectedIds = [...selected].filter((id) => locations.some((l) => l.id === id));
  const allFilteredSelected = filtered.length > 0 && filtered.every((l) => selected.has(l.id));
  const editLocation = editId === 'new' ? null : locations.find((l) => l.id === editId) || null;
  const assignLocation = locations.find((l) => l.id === assignId) || null;

  const toggle = (id) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const run = async (fn, okText) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fn();
      if (okText) setNotice({ ok: true, text: typeof okText === 'function' ? okText(r) : okText });
      await reloadLocations();
      return r;
    } catch (e) {
      setNotice({ ok: false, text: addressStorageError(e).message });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const bulk = (patch, text) => run(() => addressStorageApi.bulkUpdateLocations(warehouseId, selectedIds, patch), text);

  const removeSelected = async () => {
    if (!window.confirm(`Удалить ячеек: ${selectedIds.length}? Закрепления за ними тоже удалятся.`)) return;
    setBusy(true);
    setNotice(null);
    try {
      await addressStorageApi.deleteLocations(warehouseId, selectedIds);
    } catch (e) {
      const err = addressStorageError(e);
      if (err.code !== 'LOCATION_HAS_STOCK' || !window.confirm(`${err.message}\n\nВсё равно удалить?`)) {
        setNotice({ ok: false, text: err.message });
        setBusy(false);
        return;
      }
      try {
        await addressStorageApi.deleteLocations(warehouseId, selectedIds, { force: true });
      } catch (e2) {
        setNotice({ ok: false, text: addressStorageError(e2).message });
        setBusy(false);
        return;
      }
    }
    setSelected(new Set());
    await reloadLocations();
    setBusy(false);
  };

  const printLabels = async () => {
    const ids = selectedIds.length ? selectedIds : filtered.map((l) => l.id);
    if (!ids.length) return;
    setBusy(true);
    setNotice(null);
    try {
      const blob = await addressStorageApi.labelsPdf(warehouseId, ids);
      downloadBlob(blob, `cells-${warehouseId}.pdf`);
    } catch (e) {
      let text = addressStorageError(e).message;
      const data = e?.response?.data;
      if (data instanceof Blob) {
        try {
          text = JSON.parse(await data.text()).message || text;
        } catch {
          /* не JSON */
        }
      }
      setNotice({ ok: false, text });
    } finally {
      setBusy(false);
    }
  };

  const renumber = (strategy) =>
    run(
      () => addressStorageApi.renumberRoute(warehouseId, strategy),
      (r) => `Маршрут пересчитан для ${r.updated} ячеек`
    );

  return (
    <div className="address-locations">
      <div className="address-toolbar">
        <input
          className="form-control form-control-sm address-toolbar__search"
          placeholder="Адрес, артикул или название товара"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="form-select form-select-sm" value={rackFilter} onChange={(e) => setRackFilter(e.target.value)}>
          <option value="">Все стеллажи</option>
          {rackKeys.map((k) => (
            <option key={k} value={k}>
              {k || '—'}
            </option>
          ))}
        </select>
        <select className="form-select form-select-sm" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">Все типы</option>
          {Object.entries(LOCATION_TYPE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select className="form-select form-select-sm" value={occupancy} onChange={(e) => setOccupancy(e.target.value)}>
          <option value="">Все</option>
          <option value="empty">Пустые</option>
          <option value="busy">Занятые</option>
          <option value="inactive">Отключённые</option>
        </select>
        <div className="address-toolbar__spacer" />
        <Button size="small" onClick={() => setGenOpen(true)}>
          + Сгенерировать
        </Button>
        <Button size="small" variant="secondary" onClick={() => setEditId('new')}>
          + Ячейка
        </Button>
        <Button size="small" variant="secondary" onClick={() => setImportOpen(true)}>
          Импорт закрепления
        </Button>
        <Button size="small" variant="secondary" onClick={printLabels} disabled={busy || !filtered.length}>
          🖨 Этикетки ({selectedIds.length || filtered.length})
        </Button>
      </div>

      <div className="address-toolbar address-toolbar--secondary">
        <span className="muted-hint">
          Ячеек: {locations.length}
          {filtered.length !== locations.length ? `, показано ${filtered.length}` : ''}
          {locationsLoading ? ' · обновление…' : ''}
        </span>
        <span className="muted-hint">Маршрут обхода:</span>
        <button type="button" className="btn btn-link btn-sm p-0" disabled={busy} onClick={() => renumber('code')}>
          по адресу
        </button>
        <button type="button" className="btn btn-link btn-sm p-0" disabled={busy} onClick={() => renumber('serpentine')}>
          змейкой
        </button>
        {selectedIds.length ? (
          <span className="address-bulk">
            <strong>Выбрано: {selectedIds.length}</strong>
            <select
              className="form-select form-select-sm"
              value=""
              disabled={busy}
              onChange={(e) => e.target.value && bulk({ type: e.target.value }, 'Тип изменён')}
            >
              <option value="">Тип…</option>
              {Object.entries(LOCATION_TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-link btn-sm p-0"
              disabled={busy}
              onClick={() => {
                const v = window.prompt('Вместимость, шт (пусто — без ограничения)', '');
                if (v === null) return;
                void bulk({ capacity: v.trim() === '' ? null : Number(v) }, 'Вместимость изменена');
              }}
            >
              вместимость
            </button>
            <button type="button" className="btn btn-link btn-sm p-0" disabled={busy} onClick={() => bulk({ isActive: false }, 'Отключено')}>
              отключить
            </button>
            <button type="button" className="btn btn-link btn-sm p-0" disabled={busy} onClick={() => bulk({ isActive: true }, 'Включено')}>
              включить
            </button>
            <button type="button" className="btn btn-link btn-sm p-0 text-danger" disabled={busy} onClick={removeSelected}>
              удалить
            </button>
            <button type="button" className="btn btn-link btn-sm p-0" onClick={() => setSelected(new Set())}>
              снять выбор
            </button>
          </span>
        ) : null}
      </div>

      {notice ? (
        <div className={`alert py-2 ${notice.ok ? 'alert-success' : 'alert-danger'}`} role="status">
          {notice.text}
        </div>
      ) : null}

      {!locations.length && !locationsLoading ? (
        <div className="address-empty">
          <p>На складе ещё нет ячеек.</p>
          <Button onClick={() => setGenOpen(true)}>Сгенерировать ячейки по шаблону</Button>
        </div>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm address-table">
            <thead>
              <tr>
                <th style={{ width: 28 }}>
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={() =>
                      setSelected(allFilteredSelected ? new Set() : new Set(filtered.map((l) => l.id)))
                    }
                    aria-label="Выбрать все"
                  />
                </th>
                <th>Адрес</th>
                <th>Тип</th>
                <th className="text-end">Маршрут</th>
                <th className="text-end">Вместимость</th>
                <th>Товары</th>
                {settings.trackQuantities ? <th className="text-end">Шт</th> : null}
                <th>Штрихкод</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, limit).map((l) => (
                <tr key={l.id} className={l.isActive ? '' : 'address-row--inactive'}>
                  <td>
                    <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} />
                  </td>
                  <td>
                    <code className="address-code">{l.code}</code>
                    {l.note ? <span className="muted-hint d-block">{l.note}</span> : null}
                  </td>
                  <td>
                    <span className={`address-type address-type--${l.type}`}>{LOCATION_TYPE_LABELS[l.type]}</span>
                  </td>
                  <td className="text-end muted-hint">{l.routeOrder}</td>
                  <td className="text-end">{l.capacity ?? '—'}</td>
                  <td>
                    <div className="address-products">
                      {l.products.slice(0, 4).map((p) => (
                        <span key={p.productId} className="address-chip" title={p.name}>
                          {p.assigned ? '📌 ' : ''}
                          {p.sku || `#${p.productId}`}
                          {settings.trackQuantities && p.quantity ? ` · ${p.quantity}` : ''}
                        </span>
                      ))}
                      {l.products.length > 4 ? <span className="muted-hint">+{l.products.length - 4}</span> : null}
                    </div>
                  </td>
                  {settings.trackQuantities ? (
                    <td
                      className={`text-end${l.capacity != null && l.stockQty > l.capacity ? ' text-danger fw-bold' : ''}`}
                    >
                      {l.stockQty || '—'}
                    </td>
                  ) : null}
                  <td className="muted-hint">{l.effectiveBarcode}</td>
                  <td className="text-nowrap">
                    <button type="button" className="btn btn-link btn-sm p-0 me-2" title="Закрепить товар" onClick={() => setAssignId(l.id)}>
                      📌
                    </button>
                    <button type="button" className="btn btn-link btn-sm p-0" title="Изменить" onClick={() => setEditId(l.id)}>
                      ✏️
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > limit ? (
            <Button size="small" variant="secondary" onClick={() => setLimit((n) => n + PAGE)}>
              Показать ещё ({filtered.length - limit})
            </Button>
          ) : null}
        </div>
      )}

      <GenerateModal
        isOpen={genOpen}
        onClose={() => setGenOpen(false)}
        warehouseId={warehouseId}
        settings={settings}
        onDone={async (r) => {
          setNotice({ ok: true, text: `Создано ячеек: ${r.created}${r.skipped ? `, уже были: ${r.skipped}` : ''}` });
          await reloadLocations();
        }}
      />
      {editId != null ? (
        <EditModal
          location={editLocation}
          isNew={editId === 'new'}
          warehouseId={warehouseId}
          settings={settings}
          onClose={() => setEditId(null)}
          onSaved={reloadLocations}
        />
      ) : null}
      <ImportModal isOpen={importOpen} onClose={() => setImportOpen(false)} warehouseId={warehouseId} onDone={reloadLocations} />
      {assignLocation ? (
        <AssignProductModal
          warehouseId={warehouseId}
          location={assignLocation}
          onClose={() => setAssignId(null)}
          onChanged={reloadLocations}
        />
      ) : null}
    </div>
  );
}
