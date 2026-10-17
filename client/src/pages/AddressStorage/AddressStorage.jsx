/**
 * Адресное хранение: ячейки, стеллажи, план склада, размещение и настройки выбранного склада.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { addressStorageApi, addressStorageError } from '../../services/addressStorage.api';
import { AddressSettingsTab } from './AddressSettingsTab';
import { LocationsTab } from './LocationsTab';
import { RackViewTab } from './RackViewTab';
import { LayoutTab } from './LayoutTab';
import { MovesTab } from './MovesTab';
import './AddressStorage.css';

const TABS = [
  { key: 'locations', label: '📋 Ячейки' },
  { key: 'racks', label: '🗄 Стеллажи' },
  { key: 'layout', label: '🗺 План склада' },
  { key: 'moves', label: '↔️ Размещение' },
  { key: 'settings', label: '⚙️ Настройки' },
];

export function AddressStorage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [warehouses, setWarehouses] = useState(null);
  const [error, setError] = useState(null);
  const [locations, setLocations] = useState([]);
  const [locationsLoading, setLocationsLoading] = useState(false);

  const tab = TABS.some((t) => t.key === searchParams.get('tab')) ? searchParams.get('tab') : 'locations';
  const whParam = Number(searchParams.get('wh'));
  const warehouse = useMemo(() => {
    if (!warehouses?.length) return null;
    return warehouses.find((w) => w.id === whParam) || warehouses.find((w) => w.settings.enabled) || warehouses[0];
  }, [warehouses, whParam]);
  const warehouseId = warehouse?.id ?? null;
  const settings = warehouse?.settings ?? null;

  const setParam = useCallback(
    (patch) => {
      const next = new URLSearchParams(searchParams);
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '') next.delete(k);
        else next.set(k, String(v));
      }
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  const loadWarehouses = useCallback(async () => {
    try {
      const list = await addressStorageApi.listWarehouses({ force: true });
      setWarehouses(list || []);
      setError(null);
    } catch (e) {
      setError(addressStorageError(e).message);
      setWarehouses([]);
    }
  }, []);

  useEffect(() => {
    void loadWarehouses();
  }, [loadWarehouses]);

  const reloadLocations = useCallback(async () => {
    if (!warehouseId) return;
    setLocationsLoading(true);
    try {
      const list = (await addressStorageApi.listLocations(warehouseId)) || [];
      setLocations(list);
      // Счётчик в селекте склада должен совпадать с таблицей (после удаления/генерации).
      setWarehouses((prev) =>
        (prev || []).map((w) => (w.id === warehouseId ? { ...w, locationsCount: list.length } : w))
      );
      addressStorageApi.invalidateWarehouses();
    } catch (e) {
      setError(addressStorageError(e).message);
    } finally {
      setLocationsLoading(false);
    }
  }, [warehouseId]);

  useEffect(() => {
    setLocations([]);
    void reloadLocations();
  }, [reloadLocations]);

  const onSettingsSaved = useCallback(
    (saved) => {
      setWarehouses((list) => (list || []).map((w) => (w.id === saved.warehouseId ? { ...w, settings: saved } : w)));
      void reloadLocations();
    },
    [reloadLocations]
  );

  if (warehouses == null) return <p className="text-muted">Загрузка…</p>;
  if (!warehouses.length) {
    return (
      <div className="alert alert-info">
        {error || 'Нет собственных складов. Добавьте склад в «Настройки → Склады».'}
      </div>
    );
  }

  const tabProps = {
    warehouse,
    warehouseId,
    settings,
    locations,
    locationsLoading,
    reloadLocations,
    setParam,
    searchParams,
  };

  return (
    <div className="address-storage">
      <div className="address-storage__top">
        <label className="address-storage__wh">
          <span>Склад</span>
          <select
            className="form-select form-select-sm"
            value={warehouseId ?? ''}
            onChange={(e) => setParam({ wh: e.target.value, product: null, rack: null })}
          >
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.settings.enabled ? ` — ${w.locationsCount} яч.` : ' — выключено'}
              </option>
            ))}
          </select>
        </label>
        <div className="erp-filter-row" role="tablist" style={{ marginBottom: 0 }}>
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`erp-filter-btn${tab === t.key ? ' erp-filter-btn--active' : ''}`}
              onClick={() => setParam({ tab: t.key })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="alert alert-danger py-2" role="alert">
          {error}{' '}
          <button type="button" className="btn btn-link btn-sm p-0" onClick={() => setError(null)}>
            скрыть
          </button>
        </div>
      ) : null}

      {!settings.enabled && tab !== 'settings' ? (
        <div className="alert alert-warning py-2">
          Адресное хранение на этом складе выключено: адреса не показываются в сборке и карточке товара.{' '}
          <button type="button" className="btn btn-link btn-sm p-0" onClick={() => setParam({ tab: 'settings' })}>
            Включить в настройках
          </button>
        </div>
      ) : null}

      {tab === 'settings' && <AddressSettingsTab {...tabProps} onSaved={onSettingsSaved} />}
      {tab === 'locations' && <LocationsTab {...tabProps} />}
      {tab === 'racks' && <RackViewTab {...tabProps} />}
      {tab === 'layout' && <LayoutTab {...tabProps} />}
      {tab === 'moves' && <MovesTab {...tabProps} onSettingsSaved={onSettingsSaved} />}
    </div>
  );
}
