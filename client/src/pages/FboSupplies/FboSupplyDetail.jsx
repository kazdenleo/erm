/**
 * Карточка поставки FBO
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { useOrganizations } from '../../hooks/useOrganizations';
import { useWarehouses } from '../../hooks/useWarehouses';
import { Button } from '../../components/common/Button/Button';
import { ProductLabelPrintModal } from '../../components/products/ProductLabelPrintModal.jsx';
import {
  canUsePrintHelper,
  openProductLabelPrintTab,
  openProductLabelsBatchPrintTab,
  useProductLabelPrint,
} from '../../hooks/useProductLabelPrint.js';
import { resolveApiBaseUrl } from '../../services/api';
import {
  FBO_SUPPLY_STATUS_ORDER,
  getFboSupplyStatusLabel,
  getMarketplaceLabel,
} from '../../constants/fboSupplyStatuses';
import { FboSupplyPacking } from './FboSupplyPacking.jsx';
import { FboSupplyPackedBreakdownModal } from './FboSupplyPackedBreakdownModal.jsx';
import {
  buildStatsMap,
  isSupplyItemPackingComplete,
  sortSupplyItemsForPacking,
} from './fboSupplyPackingSort.js';
import './FboSupplies.css';

function packedCellClass(packed, planned) {
  if (packed === planned) return 'ok';
  if (packed > planned) return 'over';
  if (packed > 0) return 'short';
  return 'none';
}

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString().slice(0, 10);
}

function fmtDt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function itemToPrintProduct(it) {
  const catId = it.productCategoryId;
  return {
    id: it.productId,
    name: it.productName || it.name,
    sku: it.sku,
    user_category_id: catId,
    userCategoryId: catId,
    categoryId: catId,
  };
}

export function FboSupplyDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { organizations } = useOrganizations();
  const { warehouses } = useWarehouses();
  const [supply, setSupply] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [stockMsg, setStockMsg] = useState(null);
  const [selectedItemIds, setSelectedItemIds] = useState(() => new Set());
  const [printHelperUrl, setPrintHelperUrl] = useState('');
  const [labelPrintItem, setLabelPrintItem] = useState(null);
  const [printMsg, setPrintMsg] = useState(null);
  const [activeTab, setActiveTab] = useState('info');
  const [packing, setPacking] = useState(null);
  const [breakdownItem, setBreakdownItem] = useState(null);
  const [packingExporting, setPackingExporting] = useState(false);
  const selectAllItemsRef = useRef(null);

  const {
    printProductLabel,
    printing: labelPrinting,
    error: labelPrintError,
    setError: setLabelPrintError,
  } = useProductLabelPrint(printHelperUrl);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await fboSuppliesApi.getById(id);
      setSupply(data);
      setSelectedItemIds(new Set());
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось загрузить поставку');
    } finally {
      setLoading(false);
    }
  }, [id]);

  const loadPacking = useCallback(async () => {
    try {
      const data = await fboSuppliesApi.getPacking(id);
      setPacking(data);
    } catch {
      setPacking({ cargoUnits: [], itemStats: [] });
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (supply?.id) loadPacking();
  }, [supply?.id, loadPacking]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${resolveApiBaseUrl().replace(/\/$/, '')}/config`)
      .then((r) => r.json())
      .then((body) => {
        if (!cancelled) setPrintHelperUrl((body?.data?.printHelperUrl ?? '').trim());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const printableItems = useMemo(
    () => (supply?.items || []).filter((it) => it.productId),
    [supply?.items]
  );

  const allPrintableSelected =
    printableItems.length > 0 && printableItems.every((it) => selectedItemIds.has(String(it.id)));
  const somePrintableSelected = printableItems.some((it) => selectedItemIds.has(String(it.id)));

  useEffect(() => {
    const el = selectAllItemsRef.current;
    if (el) el.indeterminate = somePrintableSelected && !allPrintableSelected;
  }, [somePrintableSelected, allPrintableSelected]);

  const selectedPrintableItems = useMemo(
    () => printableItems.filter((it) => selectedItemIds.has(String(it.id))),
    [printableItems, selectedItemIds]
  );

  const statsByItemId = useMemo(
    () => buildStatsMap(packing?.itemStats),
    [packing?.itemStats]
  );

  const sortedSupplyItems = useMemo(
    () => sortSupplyItemsForPacking(supply?.items || [], statsByItemId),
    [supply?.items, statsByItemId]
  );

  const saveField = async (patch) => {
    setSaving(true);
    try {
      const data = await fboSuppliesApi.update(id, patch);
      setSupply(data);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const handleExportPackingExcel = async () => {
    setPackingExporting(true);
    setErr(null);
    try {
      const { buffer, filename } = await fboSuppliesApi.downloadPackingExcel(id);
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось выгрузить Excel');
    } finally {
      setPackingExporting(false);
    }
  };

  const handleAdvance = async () => {
    try {
      setStockMsg(null);
      const data = await fboSuppliesApi.advanceStatus(id);
      setSupply(data);
      const sd = data?.stockDeduction;
      if (sd?.applied) {
        setStockMsg(`Списано остатков по ${sd.deductedLines} строкам.`);
      } else if (data.status === 'shipped' && data.deductStock && sd?.error) {
        setStockMsg(sd.error);
      } else if (data.status === 'shipped' && data.deductStock && sd?.reason === 'already_deducted') {
        setStockMsg('Остатки уже были списаны ранее.');
      }
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось сменить статус');
    }
  };

  const toggleItemSelected = (itemId, e) => {
    e?.stopPropagation?.();
    const sid = String(itemId);
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  };

  const toggleSelectAllPrintable = () => {
    if (allPrintableSelected) {
      setSelectedItemIds(new Set());
    } else {
      setSelectedItemIds(new Set(printableItems.map((it) => String(it.id))));
    }
  };

  const printOneItem = async (it, copiesOverride) => {
    const copies = Math.min(99, Math.max(1, parseInt(copiesOverride ?? it.quantity, 10) || 1));
    if (!canUsePrintHelper(printHelperUrl)) {
      return openProductLabelPrintTab(it.productId, copies);
    }
    return printProductLabel(it.productId, { copies });
  };

  const buildBatchPrintItems = (items) =>
    items.map((it) => {
      const name = it.productName || it.name || '';
      const sku = it.sku ? String(it.sku) : '';
      const title = [name, sku].filter(Boolean).join(' — ') || `Товар #${it.productId}`;
      return {
        productId: it.productId,
        copies: Math.min(99, Math.max(1, parseInt(it.quantity, 10) || 1)),
        title,
      };
    });

  const totalLabelsToPrint = useMemo(
    () =>
      selectedPrintableItems.reduce(
        (sum, it) => sum + Math.min(99, Math.max(1, parseInt(it.quantity, 10) || 1)),
        0
      ),
    [selectedPrintableItems]
  );

  const handleBulkPrintLabels = () => {
    if (!selectedPrintableItems.length) {
      setPrintMsg('Отметьте одну или несколько строк в таблице (или «Выбрать все»).');
      return;
    }
    setPrintMsg(null);
    setLabelPrintError(null);
    const batchItems = buildBatchPrintItems(selectedPrintableItems);
    if (!openProductLabelsBatchPrintTab(batchItems)) {
      setPrintMsg(
        'Не удалось открыть вкладку печати. Разрешите всплывающие окна для этого сайта и повторите.'
      );
      return;
    }
    setPrintMsg(
      `Открыта печать: ${selectedPrintableItems.length} поз., всего ${totalLabelsToPrint} этикет. (по колонке «Кол-во»)`
    );
  };

  const handleSelectAllForPrint = () => {
    setSelectedItemIds(new Set(printableItems.map((it) => String(it.id))));
    setPrintMsg(null);
  };

  const handleClearSelection = () => {
    setSelectedItemIds(new Set());
    setPrintMsg(null);
  };

  const openSingleLabelModal = (it) => {
    setLabelPrintError(null);
    setLabelPrintItem(it);
  };

  const closeLabelModal = () => {
    if (labelPrinting) return;
    setLabelPrintItem(null);
    setLabelPrintError(null);
  };

  const handleSingleLabelConfirm = async (copies) => {
    const it = labelPrintItem;
    if (!it?.productId) return;
    setLabelPrintItem(null);
    const ok = await printOneItem(it, copies);
    if (!ok) {
      setLabelPrintItem(it);
      if (!labelPrintError) {
        setLabelPrintError('Не удалось напечатать. Разрешите всплывающие окна или настройте Print Helper.');
      }
    }
  };

  if (loading) return <div className="fbo-supplies-page">Загрузка…</div>;
  if (!supply) {
    return (
      <div className="fbo-supplies-page">
        <p>{err || 'Поставка не найдена'}</p>
        <Button variant="secondary" onClick={() => navigate('/fbo-supplies')}>
          К списку
        </Button>
      </div>
    );
  }

  const statusIdx = FBO_SUPPLY_STATUS_ORDER.indexOf(supply.status);

  return (
    <div className="fbo-supplies-page">
      <div className="fbo-supplies-toolbar">
        <Button variant="secondary" size="small" onClick={() => navigate('/fbo-supplies')}>
          ← К списку
        </Button>
        <h2 style={{ margin: 0, flex: 1 }}>
          Поставка FBO № {supply.id}
          {supply.externalShipmentNumber ? ` · ${supply.externalShipmentNumber}` : ''}
        </h2>
        <Button
          variant="secondary"
          size="small"
          disabled={packingExporting || !(packing?.cargoUnits?.length > 0)}
          onClick={handleExportPackingExcel}
          title="Состав по грузоместам для Ozon / WB"
        >
          {packingExporting ? 'Excel…' : 'Excel грузоместа'}
        </Button>
        <Button variant="primary" size="small" onClick={handleAdvance} disabled={statusIdx >= FBO_SUPPLY_STATUS_ORDER.length - 2}>
          Следующий шаг →
        </Button>
      </div>

      {err && <div className="alert alert-danger">{err}</div>}
      {stockMsg && (
        <div className={`alert ${stockMsg.includes('Списано') ? 'alert-success' : 'alert-warning'}`}>
          {stockMsg}
        </div>
      )}
      {printMsg && <div className="alert alert-info">{printMsg}</div>}
      {labelPrintError && !labelPrintItem && (
        <div className="alert alert-danger">{labelPrintError}</div>
      )}
      {supply.status === 'shipped' && supply.deductStock && (
        <p className="muted" style={{ fontSize: 13, marginTop: -8 }}>
          {supply.stockDeductedAt
            ? `Остатки списаны: ${fmtDt(supply.stockDeductedAt)}`
            : 'Включено списание остатков — укажите склад списания и привязанные товары, затем переведите в «Отгружен».'}
        </p>
      )}

      <div className="fbo-status-stepper">
        {FBO_SUPPLY_STATUS_ORDER.filter((s) => s !== 'return').map((s, i) => {
          const done = i < statusIdx;
          const active = s === supply.status;
          return (
            <span key={s} className={`fbo-status-step${active ? ' active' : ''}${done ? ' done' : ''}`}>
              {getFboSupplyStatusLabel(s)}
            </span>
          );
        })}
      </div>

      <div className="fbo-detail-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={`fbo-detail-tab${activeTab === 'info' ? ' active' : ''}`}
          onClick={() => setActiveTab('info')}
        >
          Общее
        </button>
        <button
          type="button"
          role="tab"
          className={`fbo-detail-tab${activeTab === 'packing' ? ' active' : ''}`}
          onClick={() => setActiveTab('packing')}
        >
          Сборка
          {packing?.cargoUnits?.length ? ` (${packing.cargoUnits.length})` : ''}
        </button>
      </div>

      {activeTab === 'packing' ? (
        <FboSupplyPacking
          supplyId={id}
          marketplace={supply.marketplace}
          supplyItems={supply.items || []}
          packing={packing}
          onPackingChange={setPacking}
          onBreakdownClick={setBreakdownItem}
        />
      ) : null}

      {activeTab === 'info' ? (
      <>
      <div className="fbo-supply-meta">
        <div>
          <label>Маркетплейс</label>
          <select
            className="form-select form-select-sm"
            value={supply.marketplace || 'ozon'}
            onChange={(e) => {
              const v = e.target.value;
              setSupply((s) => ({ ...s, marketplace: v }));
              saveField({ marketplace: v });
            }}
            disabled={saving}
          >
            <option value="ozon">Ozon</option>
            <option value="wb">Wildberries</option>
            <option value="ym">Яндекс Маркет</option>
          </select>
        </div>
        <div>
          <label>Название</label>
          <input
            className="form-control form-control-sm"
            value={supply.name || ''}
            onChange={(e) => setSupply((s) => ({ ...s, name: e.target.value }))}
            onBlur={() => saveField({ name: supply.name })}
            disabled={saving}
          />
        </div>
        <div>
          <label>Дата готовности</label>
          <input
            type="date"
            className="form-control form-control-sm"
            value={fmtDate(supply.readyAt)}
            onChange={(e) => {
              const v = e.target.value || null;
              setSupply((s) => ({ ...s, readyAt: v }));
              saveField({ readyAt: v });
            }}
            disabled={saving}
          />
        </div>
        <div>
          <label>Склад маркетплейса</label>
          <input
            className="form-control form-control-sm"
            value={supply.marketplaceWarehouseName || ''}
            onChange={(e) => setSupply((s) => ({ ...s, marketplaceWarehouseName: e.target.value }))}
            onBlur={() => saveField({ marketplaceWarehouseName: supply.marketplaceWarehouseName })}
            disabled={saving}
          />
        </div>
        <div>
          <label>Номер отгрузки</label>
          <input
            className="form-control form-control-sm"
            value={supply.externalShipmentNumber || ''}
            onChange={(e) => setSupply((s) => ({ ...s, externalShipmentNumber: e.target.value }))}
            onBlur={() => saveField({ externalShipmentNumber: supply.externalShipmentNumber })}
            disabled={saving}
            placeholder="Номер с маркетплейса"
          />
        </div>
        <div>
          <label>Организация</label>
          <select
            className="form-select form-select-sm"
            value={supply.organizationId ?? ''}
            onChange={(e) => {
              const v = e.target.value ? Number(e.target.value) : null;
              setSupply((s) => ({ ...s, organizationId: v }));
              saveField({ organizationId: v });
            }}
            disabled={saving}
          >
            <option value="">—</option>
            {(organizations || []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Склад списания остатков</label>
          <select
            className="form-select form-select-sm"
            value={supply.deductionWarehouseId ?? ''}
            onChange={(e) => {
              const v = e.target.value ? Number(e.target.value) : null;
              setSupply((s) => ({ ...s, deductionWarehouseId: v }));
              saveField({ deductionWarehouseId: v });
            }}
            disabled={saving}
          >
            <option value="">—</option>
            {(warehouses || [])
              .filter((w) => w.type === 'warehouse' && !w.supplierId)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name || w.address || `#${w.id}`}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label>Списать остатки</label>
          <div className="form-check form-switch">
            <input
              className="form-check-input"
              type="checkbox"
              checked={!!supply.deductStock}
              onChange={(e) => {
                const v = e.target.checked;
                setSupply((s) => ({ ...s, deductStock: v }));
                saveField({ deductStock: v });
              }}
              disabled={saving}
            />
          </div>
        </div>
        <div>
          <label>Создана</label>
          <div>{fmtDt(supply.createdAt)}</div>
        </div>
      </div>

      <h3 style={{ fontSize: 16, marginBottom: 8 }}>Товары поставки</h3>
      <div className="fbo-items-toolbar">
        <Button
          variant="primary"
          size="small"
          disabled={!selectedPrintableItems.length || labelPrinting}
          onClick={handleBulkPrintLabels}
          title={
            selectedPrintableItems.length
              ? `Печать ${totalLabelsToPrint} этикеток в одной вкладке`
              : 'Сначала выберите строки в таблице'
          }
        >
          Печать стикеров
          {selectedPrintableItems.length
            ? ` (${selectedPrintableItems.length} поз., ${totalLabelsToPrint} шт.)`
            : ''}
        </Button>
        <Button
          variant="secondary"
          size="small"
          disabled={!printableItems.length}
          onClick={handleSelectAllForPrint}
        >
          Выбрать все
        </Button>
        <Button
          variant="secondary"
          size="small"
          disabled={!selectedItemIds.size}
          onClick={handleClearSelection}
        >
          Снять выделение
        </Button>
        <span className="muted-hint" aria-live="polite">
          {printableItems.length ? (
            <>
              Выбрано: <strong>{selectedPrintableItems.length}</strong> из{' '}
              <strong>{printableItems.length}</strong> привязанных
              {selectedPrintableItems.length > 0 ? (
                <>
                  {' '}
                  · этикеток: <strong>{totalLabelsToPrint}</strong>
                </>
              ) : null}
              . Чекбокс в шапке — тоже «выбрать все».
            </>
          ) : (
            'Нет привязанных к ERM товаров — печать недоступна.'
          )}
        </span>
      </div>
      <div className="table-responsive">
        <table className="table table-sm table-hover">
          <thead>
            <tr>
              <th style={{ width: 36 }}>
                <input
                  ref={selectAllItemsRef}
                  type="checkbox"
                  checked={allPrintableSelected}
                  disabled={!printableItems.length}
                  onChange={toggleSelectAllPrintable}
                  title="Выбрать все привязанные товары"
                />
              </th>
              <th>Фото</th>
              <th>Название</th>
              <th>Артикул</th>
              <th>Штрихкод</th>
              <th>Кол-во</th>
              <th>Расхождения</th>
              <th style={{ width: 48 }} />
            </tr>
          </thead>
          <tbody>
            {sortedSupplyItems.map((it) => {
              const canPrint = Boolean(it.productId);
              const rowSelected = selectedItemIds.has(String(it.id));
              const stat = statsByItemId.get(String(it.id));
              const planned = stat?.planned ?? it.quantity ?? 0;
              const packed = stat?.packed ?? 0;
              const packedCls = packedCellClass(packed, planned);
              const packingComplete = isSupplyItemPackingComplete(stat, it);
              return (
                <tr
                  key={it.id}
                  className={[
                    !canPrint ? 'fbo-import-row-disabled' : '',
                    packingComplete ? 'fbo-item-row--complete' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      disabled={!canPrint}
                      checked={rowSelected}
                      onChange={(e) => toggleItemSelected(it.id, e)}
                      title={canPrint ? 'Выбрать для печати' : 'Товар не привязан к ERM'}
                    />
                  </td>
                  <td>
                    {it.productImage ? (
                      <img src={it.productImage} alt="" style={{ width: 40, height: 40, objectFit: 'cover' }} />
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {it.productName || it.name || '—'}
                    {!it.productId && <span className="fbo-import-warn"> (не привязан)</span>}
                  </td>
                  <td>{it.sku || '—'}</td>
                  <td>{it.barcode || '—'}</td>
                  <td>{it.quantity}</td>
                  <td>
                    <button
                      type="button"
                      className={`fbo-packed-cell fbo-packed-${packedCls}`}
                      onClick={() =>
                        setBreakdownItem({
                          ...it,
                          packed,
                          planned,
                          stat,
                          byCargo: stat?.byCargo || [],
                        })
                      }
                      title="Упаковано по грузоместам"
                    >
                      {packed} / {planned}
                    </button>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="secondary"
                      size="small"
                      className="btn-icon btn-icon-only"
                      disabled={!canPrint}
                      title={canPrint ? 'Печать стикера' : 'Сначала привяжите товар'}
                      aria-label="Печать стикера"
                      onClick={() => openSingleLabelModal(it)}
                    >
                      🏷️
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </>
      ) : null}

      <ProductLabelPrintModal
        isOpen={Boolean(labelPrintItem)}
        product={labelPrintItem ? itemToPrintProduct(labelPrintItem) : null}
        defaultCopies={labelPrintItem?.quantity ?? 1}
        onClose={closeLabelModal}
        onPrint={handleSingleLabelConfirm}
        printing={labelPrinting}
        error={labelPrintError}
      />

      <FboSupplyPackedBreakdownModal
        isOpen={Boolean(breakdownItem)}
        item={breakdownItem}
        onClose={() => setBreakdownItem(null)}
      />
    </div>
  );
}
