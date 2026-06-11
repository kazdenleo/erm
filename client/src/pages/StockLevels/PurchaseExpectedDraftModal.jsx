/**
 * Черновик приёмки «Ожидается»: план поставки до фактической приёмки.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../../components/common/Modal/Modal';
import { Button } from '../../components/common/Button/Button';
import { ProductSearchInput } from '../../components/common/ProductSearchInput/ProductSearchInput';
import {
  mergeProductLists,
  normalizeProductSearchQuery,
  searchProductsRemote,
} from '../../utils/productSearch';
import { purchasesApi } from '../../services/purchases.api';
import { supplierPrefixesFromApiConfig } from '../../utils/supplierArticlePrefixes';

function emptyRow() {
  return { productId: '', quantity: 1, unitPrice: '' };
}

export function PurchaseExpectedDraftModal({
  isOpen,
  onClose,
  purchaseId,
  supplierId,
  organizationId,
  suppliers = [],
  products = [],
  onSaved,
  onApplied,
  setErr,
}) {
  const [receiptId, setReceiptId] = useState(null);
  const [items, setItems] = useState([emptyRow()]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [excelLoading, setExcelLoading] = useState(false);
  const [excelInfo, setExcelInfo] = useState(null);
  const excelInputRef = useRef(null);

  const supplierPrefixes = useMemo(() => {
    const s = (suppliers || []).find((x) => String(x.id) === String(supplierId));
    return supplierPrefixesFromApiConfig(s?.api_config ?? s?.apiConfig);
  }, [suppliers, supplierId]);

  const productLabelById = useMemo(() => {
    const m = new Map();
    for (const p of products || []) {
      if (p?.id != null) m.set(String(p.id), `${p.sku || '—'} · ${p.name || ''}`.trim());
    }
    return m;
  }, [products]);

  const loadDraft = useCallback(async () => {
    if (!purchaseId) return;
    setLoading(true);
    setErr?.(null);
    try {
      const created = await purchasesApi.createExpectedReceipt(purchaseId);
      const rid = created?.id;
      if (!rid) throw new Error('Не удалось создать черновик');
      setReceiptId(rid);
      const data = await purchasesApi.getReceipt(rid);
      const rows = (data?.items || [])
        .filter((it) => it.product_id)
        .map((it) => ({
          productId: String(it.product_id),
          quantity: Math.max(1, Number(it.expected_quantity ?? it.draft_expected_quantity) || 1),
          unitPrice:
            it.purchase_price != null && it.purchase_price !== ''
              ? String(it.purchase_price)
              : '',
        }));
      setItems(rows.length > 0 ? rows : [emptyRow()]);
    } catch (e) {
      setErr?.(e.response?.data?.message || e.message || 'Не удалось открыть черновик');
      onClose?.();
    } finally {
      setLoading(false);
    }
  }, [purchaseId, onClose, setErr]);

  useEffect(() => {
    if (!isOpen) {
      setReceiptId(null);
      setItems([emptyRow()]);
      setExcelInfo(null);
      setProductSearch('');
      setSearchResults([]);
      return;
    }
    void loadDraft();
  }, [isOpen, loadDraft]);

  useEffect(() => {
    const q = normalizeProductSearchQuery(productSearch);
    if (!q || q.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return undefined;
    }
    let cancelled = false;
    setSearchLoading(true);
    const t = setTimeout(async () => {
      try {
        const remote = await searchProductsRemote(q, { organizationId, limit: 40 });
        if (!cancelled) setSearchResults(Array.isArray(remote) ? remote : []);
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 280);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [productSearch, organizationId]);

  const addProduct = (p, qty = 1) => {
    if (!p?.id) return;
    const pid = String(p.id);
    setItems((prev) => {
      const idx = prev.findIndex((x) => String(x.productId) === pid);
      if (idx >= 0) {
        return prev.map((x, i) =>
          i === idx ? { ...x, quantity: Math.max(1, (Number(x.quantity) || 0) + qty) } : x
        );
      }
      const filtered = prev.filter((x) => x.productId);
      return [...filtered, { productId: pid, quantity: qty, unitPrice: '' }];
    });
  };

  const buildPayloadItems = () =>
    items
      .map((it) => ({
        productId: parseInt(it.productId, 10),
        quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
        unitPrice: it.unitPrice === '' || it.unitPrice == null ? null : Number(it.unitPrice),
      }))
      .filter((it) => it.productId && !Number.isNaN(it.productId));

  const handleSave = async () => {
    if (!receiptId) return;
    const payload = buildPayloadItems();
    if (payload.length === 0) {
      setErr?.('Добавьте хотя бы одну позицию');
      return;
    }
    setSaving(true);
    setErr?.(null);
    try {
      await purchasesApi.saveExpectedReceiptItems(receiptId, payload);
      setExcelInfo('Черновик сохранён');
      onSaved?.();
    } catch (e) {
      setErr?.(e.response?.data?.message || e.message || 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const handleApply = async () => {
    if (!purchaseId || !receiptId) return;
    const payload = buildPayloadItems();
    if (payload.length === 0) {
      setErr?.('Добавьте хотя бы одну позицию');
      return;
    }
    setApplying(true);
    setErr?.(null);
    try {
      await purchasesApi.saveExpectedReceiptItems(receiptId, payload);
      await purchasesApi.applyExpectedReceipt(purchaseId);
      onApplied?.();
      onClose?.();
    } catch (e) {
      setErr?.(e.response?.data?.message || e.message || 'Не удалось применить к закупке');
    } finally {
      setApplying(false);
    }
  };

  const loadExcel = async (file) => {
    if (!file || !supplierId) {
      setErr?.('Выберите поставщика в закупке перед импортом Excel');
      return;
    }
    setExcelLoading(true);
    setExcelInfo(null);
    setErr?.(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('supplierId', String(supplierId));
      const res = await purchasesApi.previewExcelImport(formData);
      const tableItems = (res?.tableItems || res?.items || []).map((row) => ({
        productId: String(row.productId ?? row.product_id),
        quantity: Math.max(1, Number(row.quantity ?? row.qty) || 1),
        unitPrice:
          row.purchasePrice != null
            ? String(row.purchasePrice)
            : row.purchase_price != null
              ? String(row.purchase_price)
              : '',
      }));
      if (tableItems.length === 0) throw new Error('В файле нет распознанных позиций');
      setItems(tableItems);
      const productsFromExcel = (res?.products || []).filter((p) => p?.id != null);
      if (productsFromExcel.length > 0) {
        mergeProductLists([], productsFromExcel);
      }
      let info = `Загружено из Excel: ${res.excelDataRows ?? '—'} строк → ${tableItems.length} поз.`;
      if (Array.isArray(res.unresolved) && res.unresolved.length > 0) {
        info += ` · не найдено артикулов: ${res.unresolved.length}`;
      }
      setExcelInfo(info);
    } catch (e) {
      setErr?.(e.response?.data?.message || e.message || 'Не удалось разобрать Excel');
    } finally {
      setExcelLoading(false);
      if (excelInputRef.current) excelInputRef.current.value = '';
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={purchaseId ? `Ожидается · закупка №${purchaseId}` : 'Ожидается'}
      size="xl"
    >
      {loading ? (
        <div className="loading">Загрузка…</div>
      ) : (
        <>
          <p className="muted" style={{ marginBottom: 12 }}>
            Черновик плана поставки: добавьте позиции вручную или из Excel (Артикул · Количество · Цена).
            Кнопка «Применить к закупке» перенесёт ожидаемые кол-ва и цены в строки закупки; при приёмке
            сравнение идёт с этим черновиком.
          </p>
          <input
            ref={excelInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadExcel(f);
            }}
          />
          {supplierPrefixes.length > 0 ? (
            <p className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
              Префиксы поставщика: {supplierPrefixes.map((p) => `"${p}"`).join(', ')}
            </p>
          ) : null}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <Button
              type="button"
              variant="secondary"
              disabled={excelLoading}
              onClick={() => excelInputRef.current?.click()}
            >
              {excelLoading ? 'Загрузка…' : 'Загрузить из Excel'}
            </Button>
          </div>
          {excelInfo ? (
            <p className="muted" style={{ fontSize: 13, marginBottom: 12, color: 'var(--success, #198754)' }}>
              {excelInfo}
            </p>
          ) : null}
          <div style={{ marginBottom: 12 }}>
            <ProductSearchInput
              id="expected-draft-product-search"
              value={productSearch}
              onChange={setProductSearch}
              products={products}
              organizationId={organizationId}
              placeholder="Штрихкод, артикул, название"
              onSelect={(p) => {
                addProduct(p, 1);
                setProductSearch('');
                setSearchResults([]);
              }}
            />
            {searchLoading ? (
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Поиск…
              </p>
            ) : null}
            {!searchLoading && searchResults.length > 1 ? (
              <div
                style={{
                  marginTop: 8,
                  maxHeight: 180,
                  overflowY: 'auto',
                  border: '1px solid var(--border, #e8e8e8)',
                  borderRadius: 6,
                }}
              >
                {searchResults.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 10px',
                      border: 'none',
                      borderBottom: '1px solid var(--border, #f0f0f0)',
                      background: 'transparent',
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      addProduct(p, 1);
                      setProductSearch('');
                      setSearchResults([]);
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{p.sku || '—'}</div>
                    <div style={{ fontSize: 12, opacity: 0.85 }}>{p.name || 'Без названия'}</div>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="warehouse-ops-receipt-list-wrap" style={{ marginBottom: 12 }}>
            <table className="warehouse-ops-receipt-list-table table">
              <thead>
                <tr>
                  <th>Товар</th>
                  <th>Кол-во</th>
                  <th>Цена</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => (
                  <tr key={`${it.productId || 'new'}-${idx}`}>
                    <td>{it.productId ? productLabelById.get(String(it.productId)) || `#${it.productId}` : '—'}</td>
                    <td>
                      <input
                        className="warehouse-ops-qty-input"
                        type="number"
                        min={1}
                        value={it.quantity}
                        onChange={(e) => {
                          const v = e.target.value;
                          setItems((prev) => prev.map((x, i) => (i === idx ? { ...x, quantity: v } : x)));
                        }}
                      />
                    </td>
                    <td>
                      <input
                        className="warehouse-ops-qty-input"
                        type="number"
                        min={0}
                        step="0.01"
                        placeholder="—"
                        value={it.unitPrice}
                        onChange={(e) => {
                          const v = e.target.value;
                          setItems((prev) => prev.map((x, i) => (i === idx ? { ...x, unitPrice: v } : x)));
                        }}
                      />
                    </td>
                    <td>
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
                        disabled={items.length === 1 && !it.productId}
                      >
                        Удалить
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Button variant="secondary" onClick={() => setItems((prev) => [...prev, emptyRow()])}>
              + Позиция
            </Button>
            <Button variant="secondary" disabled={saving || applying} onClick={() => void handleSave()}>
              {saving ? 'Сохраняю…' : 'Сохранить черновик'}
            </Button>
            <Button disabled={applying || saving} onClick={() => void handleApply()}>
              {applying ? 'Применяю…' : 'Применить к закупке'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
