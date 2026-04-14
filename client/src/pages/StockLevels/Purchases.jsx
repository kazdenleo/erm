/**
 * Purchases (Stock incoming)
 * Минимальный UI: список закупок → детали → создать приёмку → сканирование.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LinkBarcodeToProductModal } from '../../components/common/LinkBarcodeToProductModal/LinkBarcodeToProductModal';
import { useNavigate } from 'react-router-dom';
import { purchasesApi } from '../../services/purchases.api';
import { useProducts } from '../../hooks/useProducts';
import { useWarehouses } from '../../hooks/useWarehouses';
import { useSuppliers } from '../../hooks/useSuppliers';
import { useOrganizations } from '../../hooks/useOrganizations';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';

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

function qtyCell(raw) {
  if (raw == null || raw === '') return '—';
  const n = Number(raw);
  return Number.isFinite(n) ? n : '—';
}

/** Частичное или полное уменьшение «ожидалось» по строке закупки (поле «На … шт.» + «Уменьшить»). */
function PurchaseLineReduceControls({
  purchaseId,
  itemId,
  expected,
  received,
  unreceived,
  onDone,
  setErr,
}) {
  const [qtyStr, setQtyStr] = useState(String(unreceived));

  useEffect(() => {
    setQtyStr(String(unreceived));
  }, [itemId, unreceived]);

  const parsed = parseInt(String(qtyStr).trim(), 10);
  const rbCap = Math.min(Math.max(1, Number.isFinite(parsed) ? parsed : 0), unreceived);
  const valid = Number.isFinite(parsed) && parsed >= 1 && parsed <= unreceived;
  const newExpected = expected - rbCap;
  const newUnreceived = newExpected - received;

  return (
    <div
      className="purchase-line-reduce-controls"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', maxWidth: 320 }}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="muted" style={{ fontSize: 12 }}>
        На
      </span>
      <input
        type="number"
        className="warehouse-ops-qty-input"
        style={{ width: 72 }}
        min={1}
        max={unreceived}
        value={qtyStr}
        onChange={(e) => setQtyStr(e.target.value)}
      />
      <span className="muted" style={{ fontSize: 12 }}>
        шт.
      </span>
      <Button
        variant="secondary"
        size="small"
        disabled={!valid}
        title={
          valid
            ? `После: ожидалось ${newExpected}, непринято ${newUnreceived}`
            : `Укажите от 1 до ${unreceived}`
        }
        onClick={async () => {
          const rb = Math.min(
            Math.max(1, parseInt(String(qtyStr).trim(), 10) || 0),
            unreceived
          );
          const ne = expected - rb;
          const nu = ne - received;
          let msg;
          if (received > 0) {
            msg = `Уменьшить ожидание на ${rb} шт.? Станет «ожидалось» ${ne} (принято ${received}), непринято ${nu}. Часть заказов в привязке сверх ${ne} вернётся в «Новый», если нет другой закупки. Дальше можно снова оформить приёмку на остаток.`;
          } else if (rb >= unreceived) {
            msg = `Снять всё непринятое (${unreceived} шт.) и удалить строку из закупки?`;
          } else {
            msg = `Уменьшить ожидание на ${rb} шт.? Останется ждать ${ne} шт. по этой строке — позже можно принять их этой же закупкой.`;
          }
          if (!window.confirm(msg)) return;
          try {
            setErr(null);
            await purchasesApi.removeDraftLineItem(purchaseId, itemId, { reduceBy: rb });
            await onDone();
          } catch (e) {
            setErr(e.response?.data?.message || e.message || 'Не удалось изменить строку');
          }
        }}
      >
        Уменьшить
      </Button>
    </div>
  );
}

function formatSourceOrders(raw) {
  if (!raw) return '—';
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return '—';
    }
  }
  if (!Array.isArray(list) || list.length === 0) return '—';
  const parts = [];
  for (const o of list) {
    if (!o) continue;
    const mp = String(o.marketplace || '').trim();
    const id = String(o.orderId ?? '').trim();
    if (!id) continue;
    parts.push(mp ? `${mp}:${id}` : id);
  }
  if (parts.length === 0) return '—';
  const shown = parts.slice(0, 4);
  const tail = parts.length > shown.length ? ` +${parts.length - shown.length}` : '';
  return shown.join(', ') + tail;
}

export function Purchases() {
  const navigate = useNavigate();
  const { products, loadProducts } = useProducts();
  const { warehouses } = useWarehouses();
  const { suppliers } = useSuppliers();
  const { organizations } = useOrganizations();
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createSupplierId, setCreateSupplierId] = useState('');
  const [createOrganizationId, setCreateOrganizationId] = useState('');
  const [createWarehouseId, setCreateWarehouseId] = useState('');
  const [createItems, setCreateItems] = useState([{ productId: '', quantity: 1 }]);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [receipt, setReceipt] = useState(null);
  const [scanValue, setScanValue] = useState('');
  const scanRef = useRef(null);
  const scanDebounceRef = useRef(null);
  const scanInFlightRef = useRef(false);
  const lastScanRef = useRef({ value: '', at: 0 });
  const [scanMsg, setScanMsg] = useState(null);
  const [extrasToResolve, setExtrasToResolve] = useState(null);
  const [receiptWarehouseId, setReceiptWarehouseId] = useState('');
  const [receiptSupplierId, setReceiptSupplierId] = useState('');
  /** null | 'asc' | 'desc' — сортировка позиций закупки по «Ожидалось» */
  const [detailExpectedQtySort, setDetailExpectedQtySort] = useState(null);
  /** null | 'asc' | 'desc' — сортировка строк приёмки по отсканированному количеству */
  const [receiptScannedQtySort, setReceiptScannedQtySort] = useState(null);
  const [linkBarcodeOpen, setLinkBarcodeOpen] = useState(false);
  const [linkBarcodeValue, setLinkBarcodeValue] = useState('');
  const purchaseLinkRetryRef = useRef(null);

  const sortedDetailItems = useMemo(() => {
    const items = detail?.items;
    if (!Array.isArray(items) || items.length === 0) return [];
    if (detailExpectedQtySort == null) return items;
    const dir = detailExpectedQtySort === 'asc' ? 1 : -1;
    const qty = (it) => {
      const n = Number(it.expected_quantity);
      return Number.isFinite(n) ? n : 0;
    };
    return [...items].sort((a, b) => {
      const d = qty(a) - qty(b);
      if (d !== 0) return d * dir;
      const sa = String(a.product_sku || a.id || '');
      const sb = String(b.product_sku || b.id || '');
      return sa.localeCompare(sb, 'ru', { numeric: true });
    });
  }, [detail?.items, detailExpectedQtySort]);

  const sortedReceiptItems = useMemo(() => {
    const items = receipt?.items;
    if (!Array.isArray(items) || items.length === 0) return [];
    if (receiptScannedQtySort == null) return items;
    const dir = receiptScannedQtySort === 'asc' ? 1 : -1;
    const qty = (it) => {
      const n = Number(it.scanned_quantity);
      return Number.isFinite(n) ? n : 0;
    };
    return [...items].sort((a, b) => {
      const d = qty(a) - qty(b);
      if (d !== 0) return d * dir;
      const sa = String(a.product_sku || a.id || '');
      const sb = String(b.product_sku || b.id || '');
      return sa.localeCompare(sb, 'ru', { numeric: true });
    });
  }, [receipt?.items, receiptScannedQtySort]);

  useEffect(() => {
    setDetailExpectedQtySort(null);
  }, [detail?.purchase?.id]);

  useEffect(() => {
    setReceiptScannedQtySort(null);
  }, [receipt?.receipt?.id]);

  const reload = async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await purchasesApi.list({ limit: 200 });
      setList(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось загрузить закупки');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    loadProducts({ limit: 2000 }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const productOptions = useMemo(() => {
    return (products || []).map((p) => ({
      id: p.id,
      label: `${p.sku || p.id} — ${p.name || 'Без названия'}`,
    }));
  }, [products]);

  const openDetail = async (id) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const data = await purchasesApi.getById(id);
      setDetail(data);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось загрузить закупку');
    } finally {
      setDetailLoading(false);
    }
  };

  const openReceipt = async (receiptId) => {
    try {
      const data = await purchasesApi.getReceipt(receiptId);
      setReceipt(data);
      setScanMsg(null);
      setReceiptWarehouseId('');
      setReceiptSupplierId(data?.purchase?.supplierId != null ? String(data.purchase.supplierId) : '');
      setTimeout(() => scanRef.current?.focus(), 80);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось открыть приёмку');
    }
  };

  const createPurchase = async () => {
    const items = createItems
      .map((it) => ({
        productId: it.productId ? Number(it.productId) : null,
        quantity: Number(it.quantity) || 1,
      }))
      .filter((it) => it.productId && it.quantity > 0);
    if (items.length === 0) {
      setErr('Добавьте хотя бы одну позицию');
      return;
    }
    try {
      const res = await purchasesApi.create({
        supplierId: createSupplierId === '' ? null : Number(createSupplierId),
        organizationId: createOrganizationId === '' ? null : Number(createOrganizationId),
        warehouseId: createWarehouseId === '' ? null : Number(createWarehouseId),
        items,
      });
      setCreateOpen(false);
      setCreateSupplierId('');
      setCreateOrganizationId('');
      setCreateWarehouseId('');
      setCreateItems([{ productId: '', quantity: 1 }]);
      await reload();
      if (res?.id) openDetail(res.id);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось создать закупку');
    }
  };

  const scan = async (valueOverride) => {
    const rid = receipt?.receipt?.id;
    const v = String(valueOverride ?? scanValue ?? '').replace(/[\r\n]+/g, '').trim();
    if (!rid || !v) return;
    // Защита от двойного скана: некоторые сканеры шлют и \n, и Enter,
    // из-за чего scan() вызывается два раза почти одновременно.
    const now = Date.now();
    if (scanInFlightRef.current) return;
    if (lastScanRef.current.value === v && now - (lastScanRef.current.at || 0) < 500) return;
    scanInFlightRef.current = true;
    lastScanRef.current = { value: v, at: now };
    try {
      setScanMsg('Сканирую…');
      await purchasesApi.scanReceipt(rid, { barcode: v });
      const data = await purchasesApi.getReceipt(rid);
      setReceipt(data);
      setScanValue('');
      setScanMsg('Ок');
      scanRef.current?.focus();
    } catch (e) {
      const msg = e.response?.data?.message || e.message || 'Ошибка сканирования';
      const st = e.response?.status;
      if (st === 404 && /не найден/i.test(String(msg))) {
        purchaseLinkRetryRef.current = { rid, barcode: v };
        setLinkBarcodeValue(v);
        setLinkBarcodeOpen(true);
        setScanMsg(null);
      } else {
        setScanMsg(msg);
      }
      setScanValue('');
      scanRef.current?.focus();
    } finally {
      scanInFlightRef.current = false;
    }
  };

  const handlePurchaseBarcodeLinked = useCallback(
    async () => {
      setLinkBarcodeOpen(false);
      setLinkBarcodeValue('');
      const pending = purchaseLinkRetryRef.current;
      purchaseLinkRetryRef.current = null;
      try {
        await loadProducts({ limit: 2000 });
      } catch (_) {
        /* ignore */
      }
      if (pending?.rid && pending?.barcode) {
        try {
          setScanMsg('Сканирую…');
          await purchasesApi.scanReceipt(pending.rid, { barcode: pending.barcode });
          const data = await purchasesApi.getReceipt(pending.rid);
          setReceipt(data);
          setScanMsg('Ок');
        } catch (e2) {
          setScanMsg(e2.response?.data?.message || e2.message || 'Ошибка сканирования');
        }
      }
      setTimeout(() => scanRef.current?.focus(), 50);
    },
    [loadProducts]
  );

  return (
    <div className="card">
      <h2 className="title">🧾 Закупка</h2>
      <p className="subtitle">Ожидание поставки (incoming) и приёмки по закупкам</p>

      {err && <p className="error">{err}</p>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <Button onClick={() => setCreateOpen(true)}>Новая закупка</Button>
        <Button variant="secondary" onClick={reload} disabled={loading}>
          {loading ? '...' : 'Обновить'}
        </Button>
      </div>

      {loading ? (
        <div className="loading">Загрузка…</div>
      ) : list.length === 0 ? (
        <p className="muted">Закупок пока нет.</p>
      ) : (
        <div className="warehouse-ops-receipts-list-wrap">
          <table className="warehouse-ops-receipt-list-table warehouse-ops-receipt-list-table--documents table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>№</th>
                <th>Поставщик</th>
                <th>Получатель</th>
                <th>Склад</th>
                <th>Заказано, шт.</th>
                <th>Принято, шт.</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr
                  key={p.id}
                  className="stock-levels-row-clickable"
                  onClick={() => openDetail(p.id)}
                >
                  <td>{fmtDt(p.created_at)}</td>
                  <td>№{p.id}</td>
                  <td>{p.supplier_name || '—'}</td>
                  <td>{p.organization_name || '—'}</td>
                  <td>{p.warehouse_name || '—'}</td>
                  <td>{qtyCell(p.expected_total ?? p.expectedTotal)}</td>
                  <td>{qtyCell(p.received_total ?? p.receivedTotal)}</td>
                  <td>
                    <span className="muted">Подробнее →</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title="Новая закупка" size="large">
        <p className="muted">Выберите поставщика/получателя/склад (опционально), затем добавьте позиции.</p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <span className="muted" style={{ fontSize: 13 }}>Поставщик</span>
          <select className="warehouse-ops-select" value={createSupplierId} onChange={(e) => setCreateSupplierId(e.target.value)}>
            <option value="">— Не указан —</option>
            {(suppliers || []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || `Поставщик #${s.id}`}
              </option>
            ))}
          </select>

          <span className="muted" style={{ fontSize: 13 }}>Получатель</span>
          <select
            className="warehouse-ops-select"
            value={createOrganizationId}
            onChange={(e) => setCreateOrganizationId(e.target.value)}
          >
            <option value="">— Не указан —</option>
            {(organizations || []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name || `Организация #${o.id}`}
              </option>
            ))}
          </select>

          <span className="muted" style={{ fontSize: 13 }}>Склад</span>
          <select className="warehouse-ops-select" value={createWarehouseId} onChange={(e) => setCreateWarehouseId(e.target.value)}>
            <option value="">— Не указан —</option>
            {(warehouses || [])
              .filter((w) => w?.type === 'warehouse' && !w?.supplier_id)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name || w.address || w.city || `Склад #${w.id}`}
                </option>
              ))}
          </select>
        </div>
        {createItems.map((it, idx) => (
          <div key={idx} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <select
              className="warehouse-ops-select"
              value={it.productId}
              onChange={(e) => {
                const v = e.target.value;
                setCreateItems((prev) => prev.map((x, i) => (i === idx ? { ...x, productId: v } : x)));
              }}
            >
              <option value="">— Выберите товар —</option>
              {productOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <input
              className="warehouse-ops-qty-input"
              type="number"
              min={1}
              value={it.quantity}
              onChange={(e) => {
                const v = e.target.value;
                setCreateItems((prev) => prev.map((x, i) => (i === idx ? { ...x, quantity: v } : x)));
              }}
            />
            <Button
              variant="secondary"
              onClick={() => setCreateItems((prev) => prev.filter((_, i) => i !== idx))}
              disabled={createItems.length === 1}
            >
              Удалить
            </Button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={() => setCreateItems((prev) => [...prev, { productId: '', quantity: 1 }])}>
            + Позиция
          </Button>
          <Button onClick={createPurchase}>Сохранить</Button>
        </div>
      </Modal>

      <Modal
        isOpen={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.purchase?.id ? `Закупка №${detail.purchase.id}` : 'Закупка'}
        size="large"
      >
        {detailLoading ? (
          <div className="loading">Загрузка…</div>
        ) : detail?.purchase ? (
          <>
            <p className="warehouse-ops-hint" style={{ marginBottom: 12 }}>
              Создана: {fmtDt(detail.purchase.created_at)}. Ожидание (incoming) и резервы по заказам формируются при добавлении
              позиций; при приёмке товар уходит из ожидания на склад.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <span className="muted" style={{ fontSize: 13 }}>Поставщик</span>
              <select
                className="warehouse-ops-select"
                value={detail.purchase.supplier_id != null ? String(detail.purchase.supplier_id) : ''}
                onChange={async (e) => {
                  const v = e.target.value;
                  try {
                    setErr(null);
                    await purchasesApi.updatePurchase(detail.purchase.id, {
                      supplierId: v === '' ? null : Number(v),
                    });
                    await openDetail(detail.purchase.id);
                    await reload();
                  } catch (ex) {
                    setErr(ex.response?.data?.message || ex.message || 'Не удалось обновить поставщика');
                  }
                }}
              >
                <option value="">— Не указан —</option>
                {(suppliers || []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || `Поставщик #${s.id}`}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <span className="muted" style={{ fontSize: 13 }}>Получатель</span>
              <select
                className="warehouse-ops-select"
                value={detail.purchase.organization_id != null ? String(detail.purchase.organization_id) : ''}
                onChange={async (e) => {
                  const v = e.target.value;
                  try {
                    setErr(null);
                    await purchasesApi.updatePurchase(detail.purchase.id, {
                      organizationId: v === '' ? null : Number(v),
                    });
                    await openDetail(detail.purchase.id);
                    await reload();
                  } catch (ex) {
                    setErr(ex.response?.data?.message || ex.message || 'Не удалось обновить получателя');
                  }
                }}
              >
                <option value="">— Не указан —</option>
                {(organizations || []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name || `Организация #${o.id}`}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <span className="muted" style={{ fontSize: 13 }}>Склад (назначение)</span>
              <select
                className="warehouse-ops-select"
                value={detail.purchase.warehouse_id != null ? String(detail.purchase.warehouse_id) : ''}
                onChange={async (e) => {
                  const v = e.target.value;
                  try {
                    setErr(null);
                    await purchasesApi.updatePurchase(detail.purchase.id, {
                      warehouseId: v === '' ? null : Number(v),
                    });
                    await openDetail(detail.purchase.id);
                    await reload();
                  } catch (ex) {
                    setErr(ex.response?.data?.message || ex.message || 'Не удалось обновить склад');
                  }
                }}
              >
                <option value="">— Не указан —</option>
                {(warehouses || [])
                  .filter((w) => w?.type === 'warehouse' && !w?.supplier_id)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name || w.address || w.city || `Склад #${w.id}`}
                    </option>
                  ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              <Button
                onClick={async () => {
                  const existingScanning = Array.isArray(detail?.receipts)
                    ? detail.receipts.find((x) => String(x?.status) === 'scanning')
                    : null;
                  if (existingScanning?.id) {
                    setErr(`У этой закупки уже есть незавершённая приёмка №${existingScanning.id}. Открываю её.`);
                    await openReceipt(existingScanning.id);
                    return;
                  }
                  const r = await purchasesApi.createReceipt(detail.purchase.id);
                  await openDetail(detail.purchase.id);
                  await openReceipt(r.id);
                }}
              >
                Создать приёмку (сканирование)
              </Button>
              <Button
                variant="secondary"
                onClick={async (e) => {
                  e.stopPropagation();
                  if (
                    !window.confirm(
                      `Удалить закупку №${detail.purchase.id} со всеми приёмками? Будет выполнен откат (сторно): в журнал движений добавятся обратные проводки, старые записи не удаляются. Остатки и incoming будут скорректированы; заказы из «В закупке» вернутся в «Новые», резерв снимется.`
                    )
                  ) {
                    return;
                  }
                  try {
                    setErr(null);
                    await purchasesApi.deletePurchase(detail.purchase.id);
                    setDetail(null);
                    await reload();
                  } catch (ex) {
                    setErr(ex.response?.data?.message || ex.message || 'Не удалось удалить закупку');
                  }
                }}
              >
                Удалить закупку
              </Button>
            </div>
            <h4>Позиции</h4>
            <p className="muted" style={{ marginBottom: 10, fontSize: 13 }}>
              Если «ожидалось» больше «принято», укажите в штуках, на сколько уменьшить ожидание (не обязательно на всё непринятое):
              остаток по строке можно принять позже той же закупкой. Incoming уменьшится на выбранное число; уже принятое на склад не
              затрагивается. Заказы в привязке сверх нового «ожидалось» вернутся в «Новый», если нет другой закупки.
            </p>
            {Array.isArray(detail.items) && detail.items.length > 0 ? (
              <div className="warehouse-ops-receipt-list-wrap">
                <table className="warehouse-ops-receipt-list-table table">
                  <thead>
                    <tr>
                      <th>Артикул</th>
                      <th>Товар</th>
                      <th>Под заказы</th>
                      <th>Закуп. цена</th>
                      <th>
                        <button
                          type="button"
                          onClick={() =>
                            setDetailExpectedQtySort((prev) =>
                              prev == null ? 'asc' : prev === 'asc' ? 'desc' : null
                            )
                          }
                          title={
                            detailExpectedQtySort == null
                              ? 'Сортировать по ожидаемому количеству'
                              : detailExpectedQtySort === 'asc'
                                ? 'Сейчас по возрастанию — по убыванию'
                                : 'Сбросить сортировку'
                          }
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            font: 'inherit',
                            padding: 0,
                            textAlign: 'left',
                            textDecoration: detailExpectedQtySort ? 'underline' : 'underline dotted',
                            fontWeight: detailExpectedQtySort ? 600 : 400,
                            color: 'inherit',
                          }}
                        >
                          Ожидалось
                          {detailExpectedQtySort === 'asc' ? ' ↑' : ''}
                          {detailExpectedQtySort === 'desc' ? ' ↓' : ''}
                        </button>
                      </th>
                      <th>Принято</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedDetailItems.map((it) => (
                      <tr key={it.id}>
                        <td className="sku-cell">{it.product_sku || '—'}</td>
                        <td className="name-cell">{it.product_name || '—'}</td>
                        <td className="muted" title={formatSourceOrders(it.source_orders)} style={{ maxWidth: 260 }}>
                          {formatSourceOrders(it.source_orders)}
                        </td>
                        <td style={{ width: 140 }} onClick={(e) => e.stopPropagation()}>
                          <input
                            className="warehouse-ops-qty-input"
                            type="number"
                            min={0}
                            step="0.01"
                            value={it.purchase_price ?? it.product_cost ?? ''}
                            onChange={async (e) => {
                              const v = e.target.value;
                              try {
                                setErr(null);
                                await purchasesApi.updatePurchaseItem(detail.purchase.id, it.id, {
                                  purchasePrice: v === '' ? null : Number(v),
                                });
                                await openDetail(detail.purchase.id);
                              } catch (ex) {
                                setErr(ex.response?.data?.message || ex.message || 'Не удалось сохранить цену');
                              }
                            }}
                          />
                        </td>
                        <td>{it.expected_quantity}</td>
                        <td>{it.received_quantity}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {(() => {
                            const exp = Number(it.expected_quantity);
                            const rec = Number(it.received_quantity);
                            const expected = Math.max(
                              0,
                              Math.floor(Number.isFinite(exp) ? exp : 0)
                            );
                            const received = Math.max(
                              0,
                              Math.floor(Number.isFinite(rec) ? rec : 0)
                            );
                            const unreceived = Math.max(0, expected - received);
                            if (unreceived <= 0) {
                              return <span className="muted">—</span>;
                            }
                            return (
                              <PurchaseLineReduceControls
                                purchaseId={detail.purchase.id}
                                itemId={it.id}
                                expected={expected}
                                received={received}
                                unreceived={unreceived}
                                setErr={setErr}
                                onDone={async () => {
                                  await openDetail(detail.purchase.id);
                                  await reload();
                                }}
                              />
                            );
                          })()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">Нет строк.</p>
            )}

            <h4 style={{ marginTop: 14 }}>Приёмки</h4>
            {Array.isArray(detail.receipts) && detail.receipts.length > 0 ? (
              <div className="warehouse-ops-receipt-list-wrap">
                <table className="warehouse-ops-receipt-list-table warehouse-ops-receipt-list-table--documents table">
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>№</th>
                      <th>Статус</th>
                      <th>Позиций</th>
                      <th />
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {detail.receipts.map((r) => (
                      <tr key={r.id} className="stock-levels-row-clickable" onClick={() => openReceipt(r.id)}>
                        <td>{fmtDt(r.created_at)}</td>
                        <td>№{r.id}</td>
                        <td>{r.status}</td>
                        <td>{r.items_count ?? '—'}</td>
                        <td>
                          <span className="muted">Открыть →</span>
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <Button
                            variant="secondary"
                            size="small"
                            onClick={async () => {
                              const completed = String(r.status) === 'completed';
                              const msg = completed
                                ? `Удалить приёмку №${r.id}? Сторно: остатки и incoming будут откатаны новыми проводками в журнале; исходные записи приёмки останутся в истории.`
                                : `Удалить приёмку №${r.id} (сканирование)? Черновик и строки складской приёмки будут сняты (в журнал движений это не пишется, т.к. приёмка не была завершена).`;
                              if (!window.confirm(msg)) return;
                              try {
                                setErr(null);
                                await purchasesApi.deleteReceipt(r.id);
                                await openDetail(detail.purchase.id);
                                await reload();
                                if (receipt?.receipt?.id === r.id) setReceipt(null);
                              } catch (ex) {
                                setErr(ex.response?.data?.message || ex.message || 'Не удалось удалить приёмку');
                              }
                            }}
                          >
                            Удалить
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">Пока нет приёмок.</p>
            )}
          </>
        ) : null}
      </Modal>

      <Modal
        isOpen={!!receipt?.receipt?.id}
        onClose={() => setReceipt(null)}
        title={receipt?.receipt?.id ? `Приёмка №${receipt.receipt.id}` : 'Приёмка'}
        size="large"
      >
        {receipt?.receipt ? (
          <>
            <p className="warehouse-ops-hint" style={{ marginBottom: 12 }}>
              статус: {receipt.receipt.status} · закупка №{receipt.receipt.purchase_id}
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <span className="muted" style={{ fontSize: 13 }}>Поставщик</span>
              <select
                className="warehouse-ops-select"
                value={receiptSupplierId}
                onChange={async (e) => {
                  const v = e.target.value;
                  setReceiptSupplierId(v);
                  try {
                    setErr(null);
                    await purchasesApi.updatePurchase(receipt.receipt.purchase_id, {
                      supplierId: v === '' ? null : Number(v),
                    });
                    if (detail?.purchase?.id) await openDetail(detail.purchase.id);
                    await openReceipt(receipt.receipt.id);
                  } catch (ex) {
                    setErr(ex.response?.data?.message || ex.message || 'Не удалось обновить поставщика');
                  }
                }}
              >
                <option value="">— Не указан —</option>
                {(suppliers || []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || `Поставщик #${s.id}`}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <span className="muted" style={{ fontSize: 13 }}>Склад приёмки</span>
              <select
                className="warehouse-ops-select"
                value={receiptWarehouseId}
                onChange={(e) => setReceiptWarehouseId(e.target.value)}
              >
                <option value="">— По умолчанию —</option>
                {(warehouses || [])
                  .filter((w) => w?.type === 'warehouse' && !w?.supplier_id)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name || w.address || w.city || `Склад #${w.id}`}
                    </option>
                  ))}
              </select>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (scanDebounceRef.current) clearTimeout(scanDebounceRef.current);
                scan();
              }}
              className="warehouse-ops-scan-form warehouse-ops-scan-form--no-btn"
            >
              <input
                ref={scanRef}
                className="warehouse-ops-scan-input"
                value={scanValue}
                onChange={(e) => {
                  const v = e.target.value;
                  setScanValue(v);
                  if (scanDebounceRef.current) clearTimeout(scanDebounceRef.current);

                  // 1) Некоторые сканеры вставляют \r/\n вместо Enter
                  if (/[\r\n]/.test(v)) {
                    // Важно: некоторые сканеры ещё и шлют Enter → не допускаем двойной отправки
                    scanDebounceRef.current = setTimeout(() => scan(v), 0);
                    return;
                  }

                  // 2) Многие сканеры не отправляют Enter вообще — просто быстро "набирают" символы
                  // Если ввод не менялся ~120мс, считаем что скан завершён и отправляем.
                  if (String(v).trim().length >= 4) {
                    scanDebounceRef.current = setTimeout(() => scan(v), 120);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (scanDebounceRef.current) clearTimeout(scanDebounceRef.current);
                    // Если сканер "вставил" перенос строки в значение, onChange уже отправит scan()
                    if (/[\r\n]/.test(e.currentTarget.value)) return;
                    scan(e.currentTarget.value);
                  }
                }}
                placeholder="Сканируйте штрихкод (1 скан = +1)"
                autoComplete="off"
              />
            </form>
            {scanMsg && <p className="muted" style={{ marginTop: 8 }}>{scanMsg}</p>}

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
              <Button
                onClick={async () => {
                  const res = await purchasesApi.completeReceipt(receipt.receipt.id, {
                    warehouseId: receiptWarehouseId || null,
                  });
                  setReceipt(null);
                  setScanMsg(null);
                  await reload();
                  if (detail?.purchase?.id) await openDetail(detail.purchase.id);
                  if (Array.isArray(res?.extras) && res.extras.length > 0) {
                    setExtrasToResolve({
                      receiptId: receipt.receipt.id,
                      purchaseId: res.purchaseId,
                      extras: res.extras,
                      warehouseId: res.warehouseId ?? (receiptWarehouseId || null),
                    });
                  }
                  if (res?.stockProblems?.length) {
                    setErr(`Проблемы с покрытием резерва: ${res.stockProblems.length} SKU`);
                  }
                  if (res?.warehouseReceiptId) {
                    navigate('/stock-levels/warehouse?op=receipts_list', {
                      state: { openReceiptId: res.warehouseReceiptId }
                    });
                  }
                }}
              >
                Завершить приёмку
              </Button>
              <Button variant="secondary" onClick={() => openReceipt(receipt.receipt.id)}>
                Обновить
              </Button>
            </div>

            <h4 style={{ marginTop: 14 }}>Отсканировано</h4>
            {Array.isArray(receipt.items) && receipt.items.length > 0 ? (
              <div className="warehouse-ops-receipt-list-wrap">
                <table className="warehouse-ops-receipt-list-table table">
                  <thead>
                    <tr>
                      <th>Артикул</th>
                      <th>Товар</th>
                      <th>Закуп. цена</th>
                      <th>Заказано</th>
                      <th>Принято (итого)</th>
                      <th>
                        <button
                          type="button"
                          onClick={() =>
                            setReceiptScannedQtySort((prev) =>
                              prev == null ? 'asc' : prev === 'asc' ? 'desc' : null
                            )
                          }
                          title={
                            receiptScannedQtySort == null
                              ? 'Сортировать по количеству'
                              : receiptScannedQtySort === 'asc'
                                ? 'Сейчас по возрастанию — по убыванию'
                                : 'Сбросить сортировку'
                          }
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            font: 'inherit',
                            padding: 0,
                            textAlign: 'left',
                            textDecoration: receiptScannedQtySort ? 'underline' : 'underline dotted',
                            fontWeight: receiptScannedQtySort ? 600 : 400,
                            color: 'inherit',
                          }}
                        >
                          Кол-во
                          {receiptScannedQtySort === 'asc' ? ' ↑' : ''}
                          {receiptScannedQtySort === 'desc' ? ' ↓' : ''}
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedReceiptItems.map((it) => (
                      <tr key={it.id}>
                        <td className="sku-cell">{it.product_sku || '—'}</td>
                        <td className="name-cell">{it.product_name || '—'}</td>
                        <td style={{ width: 140 }}>
                          <input
                            className="warehouse-ops-qty-input"
                            type="number"
                            min={0}
                            step="0.01"
                            value={it.purchase_price ?? it.product_cost ?? ''}
                            onChange={async (e) => {
                              const v = e.target.value;
                              const purchaseItemId = it.purchase_item_id;
                              if (!purchaseItemId) return;
                              try {
                                setErr(null);
                                await purchasesApi.updatePurchaseItem(receipt.receipt.purchase_id, purchaseItemId, {
                                  purchasePrice: v === '' ? null : Number(v),
                                });
                                await openReceipt(receipt.receipt.id);
                                if (detail?.purchase?.id) await openDetail(detail.purchase.id);
                              } catch (ex) {
                                setErr(ex.response?.data?.message || ex.message || 'Не удалось сохранить цену');
                              }
                            }}
                          />
                        </td>
                        <td>{it.expected_quantity ?? '—'}</td>
                        <td>{it.received_quantity ?? '—'}</td>
                        <td>{it.scanned_quantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">Пока ничего не отсканировано.</p>
            )}
          </>
        ) : null}
      </Modal>

      <Modal
        isOpen={!!extrasToResolve}
        onClose={() => setExtrasToResolve(null)}
        title="Излишки по приёмке"
        size="large"
      >
        {extrasToResolve ? (
          <>
            <p className="warehouse-ops-hint">
              Найдены излишки по закупке №{extrasToResolve.purchaseId}. Выберите действие: допринять на склад или оформить возврат поставщику.
            </p>
            <div className="warehouse-ops-receipt-list-wrap" style={{ marginTop: 10 }}>
              <table className="warehouse-ops-receipt-list-table warehouse-ops-receipt-list-table--line-items table">
                <thead>
                  <tr>
                    <th>Артикул</th>
                    <th>Товар</th>
                    <th>Кол-во</th>
                  </tr>
                </thead>
                <tbody>
                  {extrasToResolve.extras.map((x) => (
                    <tr key={x.productId}>
                      <td className="sku-cell">{x.sku || '—'}</td>
                      <td className="name-cell">{x.name || '—'}</td>
                      <td>{x.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
              <Button
                onClick={async () => {
                  await purchasesApi.resolveExtras(extrasToResolve.receiptId, {
                    action: 'accept',
                    warehouseId: extrasToResolve.warehouseId ?? null,
                  });
                  setExtrasToResolve(null);
                  await reload();
                }}
              >
                Допринять на склад
              </Button>
              <Button
                variant="secondary"
                onClick={async () => {
                  await purchasesApi.resolveExtras(extrasToResolve.receiptId, {
                    action: 'return',
                    warehouseId: extrasToResolve.warehouseId ?? null,
                  });
                  setExtrasToResolve(null);
                  await reload();
                  setErr('Создан возврат поставщику (черновик).');
                }}
              >
                Создать возврат поставщику
              </Button>
            </div>
          </>
        ) : null}
      </Modal>

      <LinkBarcodeToProductModal
        isOpen={linkBarcodeOpen}
        onClose={() => {
          setLinkBarcodeOpen(false);
          setLinkBarcodeValue('');
          purchaseLinkRetryRef.current = null;
        }}
        barcode={linkBarcodeValue}
        products={products}
        onLinked={handlePurchaseBarcodeLinked}
      />
    </div>
  );
}

