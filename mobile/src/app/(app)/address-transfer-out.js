/**
 * Документ ПМ: скан ячейки-источника → товары с количеством → склад куда → один документ.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../context/AuthContext';
import { addressStorageApi, receiptsApi } from '../../api/erp';
import { errorMessage } from '../../api/client';
import { scanError, scanOk } from '../../lib/feedback';
import { ScanBar } from '../../components/ScanBar';
import { Banner, Button, Card, Field, Loading } from '../../ui/components';
import { colors } from '../../ui/theme';

export default function AddressTransferOutScreen() {
  const { organizationId } = useAuth();
  const busyRef = useRef(false);
  const [warehouses, setWarehouses] = useState(null);
  const [fromWarehouseId, setFromWarehouseId] = useState(null);
  const [toWarehouseId, setToWarehouseId] = useState(null);
  const [cell, setCell] = useState(null);
  const [lines, setLines] = useState([]);
  const [draftQty, setDraftQty] = useState({});
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    addressStorageApi.listWarehouses().then(
      (all) => {
        const list = (all || []).filter(
          (w) => organizationId == null || Number(w.organizationId) === Number(organizationId)
        );
        setWarehouses(list);
        const withCells = list.filter((w) => w.settings?.enabled && w.settings?.trackQuantities);
        if (withCells.length === 1) setFromWarehouseId(withCells[0].id);
      },
      (e) => {
        setWarehouses([]);
        setMessage({ kind: 'error', text: errorMessage(e, 'Не удалось загрузить склады') });
      }
    );
  }, [organizationId]);

  const sourceWarehouses = useMemo(
    () => (warehouses || []).filter((w) => w.settings?.enabled && w.settings?.trackQuantities),
    [warehouses]
  );

  const destWarehouses = useMemo(
    () =>
      (warehouses || []).filter(
        (w) =>
          Number(w.id) !== Number(fromWarehouseId) &&
          Number(w.organizationId) ===
            Number((warehouses || []).find((x) => Number(x.id) === Number(fromWarehouseId))?.organizationId)
      ),
    [warehouses, fromWarehouseId]
  );

  const resetDoc = useCallback(() => {
    setCell(null);
    setLines([]);
    setDraftQty({});
  }, []);

  useEffect(() => {
    resetDoc();
    setToWarehouseId(null);
    setMessage(null);
  }, [fromWarehouseId, resetDoc]);

  useEffect(() => {
    if (!toWarehouseId && destWarehouses.length === 1) setToWarehouseId(destWarehouses[0].id);
  }, [toWarehouseId, destWarehouses]);

  const qtyInCart = useCallback(
    (productId) => lines.find((l) => Number(l.productId) === Number(productId))?.quantity || 0,
    [lines]
  );

  const availableInCell = useCallback(
    (productId) => {
      const item = (cell?.items || []).find((it) => Number(it.productId) === Number(productId));
      return Math.max(0, (item?.quantity || 0) - qtyInCart(productId));
    },
    [cell, qtyInCart]
  );

  const putLine = (item, quantity) => {
    const qty = Math.floor(Number(quantity) || 0);
    if (qty < 1) {
      setMessage({ kind: 'error', text: 'Укажите количество' });
      return false;
    }
    const already = qtyInCart(item.productId);
    const maxTotal = availableInCell(item.productId) + already;
    if (qty > maxTotal) {
      setMessage({ kind: 'error', text: `В ячейке только ${maxTotal} шт` });
      return false;
    }
    setLines((prev) => {
      const rest = prev.filter((l) => Number(l.productId) !== Number(item.productId));
      return [
        ...rest,
        {
          productId: item.productId,
          sku: item.sku,
          name: item.name,
          quantity: qty,
        },
      ];
    });
    setDraftQty((d) => ({ ...d, [item.productId]: String(qty) }));
    setMessage(null);
    return true;
  };

  const handleScan = useCallback(
    async (raw) => {
      const code = String(raw || '').trim();
      if (!code || !fromWarehouseId || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const r = await addressStorageApi.resolveScan(fromWarehouseId, code);
        if (!r) {
          scanError();
          setMessage({ kind: 'error', text: `Не распознано: «${code}»` });
          return;
        }
        if (r.type === 'location' || r.location) {
          scanOk();
          const items = r.items || [];
          setCell({ location: r.location, items });
          const drafts = {};
          for (const it of items) drafts[it.productId] = String(it.quantity);
          setDraftQty(drafts);
          if (items.length === 1) {
            const it = items[0];
            setLines([
              { productId: it.productId, sku: it.sku, name: it.name, quantity: it.quantity },
            ]);
          } else {
            setLines([]);
          }
          return;
        }
        if ((r.type === 'product' || r.product) && cell) {
          const item = (cell.items || []).find((it) => Number(it.productId) === Number(r.product.id));
          if (!item) {
            scanError();
            setMessage({ kind: 'error', text: 'Товара нет в этой ячейке' });
            return;
          }
          scanOk();
          const next = qtyInCart(item.productId) + 1;
          if (next > item.quantity) {
            setMessage({ kind: 'error', text: 'Больше остатка в ячейке' });
            return;
          }
          putLine(item, next);
          return;
        }
        scanError();
        setMessage({ kind: 'error', text: 'Сначала отсканируйте ячейку' });
      } catch (e) {
        scanError();
        setMessage({ kind: 'error', text: errorMessage(e, 'Ошибка скана') });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [fromWarehouseId, cell, qtyInCart]
  );

  const submit = async () => {
    if (!cell?.location?.id) {
      setMessage({ kind: 'error', text: 'Отсканируйте ячейку' });
      return;
    }
    if (!toWarehouseId) {
      setMessage({ kind: 'error', text: 'Выберите склад куда' });
      return;
    }
    if (!lines.length) {
      setMessage({ kind: 'error', text: 'Добавьте товары' });
      return;
    }
    const src = (warehouses || []).find((w) => Number(w.id) === Number(fromWarehouseId));
    const orgId = src?.organizationId || organizationId;
    if (!orgId) {
      setMessage({ kind: 'error', text: 'Не определена организация' });
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const res = await receiptsApi.create({
        documentType: 'transfer',
        organizationId: Number(orgId),
        warehouseId: Number(fromWarehouseId),
        toWarehouseId: Number(toWarehouseId),
        lines: lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          fromLocationId: Number(cell.location.id),
        })),
      });
      const receipt = res?.receipt || res;
      const num = receipt?.receipt_number || receipt?.receiptNumber || '';
      const totalQty = lines.reduce((s, l) => s + l.quantity, 0);
      scanOk();
      setMessage({
        kind: 'success',
        text: `ПМ ${num} · ${lines.length} поз. / ${totalQty} шт из ${cell.location.code}`,
      });
      resetDoc();
    } catch (e) {
      scanError();
      setMessage({ kind: 'error', text: errorMessage(e, 'Не удалось создать перемещение') });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (warehouses === null) return <Loading text="Загружаем склады…" />;

  const destName = destWarehouses.find((w) => String(w.id) === String(toWarehouseId))?.name;

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.hint}>
        Скан ячейки → если товаров несколько, выберите один → склад назначения. Товар снимается с ячейки.
      </Text>

      <Banner kind={message?.kind} text={message?.text} onClose={() => setMessage(null)} />

      <Card style={styles.gap}>
        <Text style={styles.section}>Склад откуда</Text>
        {sourceWarehouses.length === 0 ? (
          <Text style={styles.muted}>Нет складов с учётом по ячейкам</Text>
        ) : (
          sourceWarehouses.map((w) => {
            const active = String(w.id) === String(fromWarehouseId);
            return (
              <Pressable
                key={w.id}
                onPress={() => setFromWarehouseId(w.id)}
                style={[styles.option, active && styles.optionActive]}
              >
                <Text style={[styles.optionText, active && styles.optionTextActive]}>
                  {w.name || `Склад #${w.id}`}
                </Text>
              </Pressable>
            );
          })
        )}
      </Card>

      {fromWarehouseId ? (
        <>
          <Card style={styles.gap}>
            <Text style={styles.section}>Склад куда</Text>
            {destWarehouses.length === 0 ? (
              <Text style={styles.muted}>Нет другого склада</Text>
            ) : (
              destWarehouses.map((w) => {
                const active = String(w.id) === String(toWarehouseId);
                return (
                  <Pressable
                    key={w.id}
                    onPress={() => setToWarehouseId(w.id)}
                    style={[styles.option, active && styles.optionActive]}
                  >
                    <Text style={[styles.optionText, active && styles.optionTextActive]}>{w.name}</Text>
                  </Pressable>
                );
              })
            )}
          </Card>

          <ScanBar
            onScan={handleScan}
            busy={busy}
            placeholder={cell ? 'Товар из ячейки или снова ячейка' : 'Сканируйте ячейку откуда'}
          />

          {cell ? (
            <Card style={styles.gap}>
              <View style={styles.rowBetween}>
                <Text style={styles.section}>Ячейка {cell.location.code}</Text>
                <Button title="Сменить" variant="secondary" small onPress={resetDoc} disabled={busy} />
              </View>
              {(cell.items || []).length === 0 ? <Text style={styles.muted}>Пусто</Text> : null}
              {(cell.items || []).length > 1 ? (
                <Text style={styles.muted}>Выберите один товар</Text>
              ) : null}
              {(cell.items || []).map((it) => {
                const inDoc = qtyInCart(it.productId);
                const selected = inDoc > 0;
                return (
                  <Pressable
                    key={it.productId}
                    disabled={busy}
                    onPress={() => {
                      // Один товар из ячейки: выбор заменяет предыдущие позиции из этого скана.
                      setLines([
                        {
                          productId: it.productId,
                          sku: it.sku,
                          name: it.name,
                          quantity: Math.max(1, Number(it.quantity) || 1),
                        },
                      ]);
                      setDraftQty({ [it.productId]: String(it.quantity) });
                      setMessage(null);
                      scanOk();
                    }}
                    style={[styles.itemRow, selected && styles.itemRowActive]}
                  >
                    <Text style={[styles.itemTitle, selected && styles.itemTitleActive]}>
                      {it.sku} · {it.quantity} шт
                      {selected ? ' · выбран' : ''}
                    </Text>
                    <Text style={styles.muted}>{it.name}</Text>
                  </Pressable>
                );
              })}
              {lines.length === 1 && cell.items?.length ? (
                <Field
                  label="Количество"
                  value={draftQty[lines[0].productId] ?? String(lines[0].quantity)}
                  onChangeText={(v) => {
                    setDraftQty((d) => ({ ...d, [lines[0].productId]: v }));
                    const qty = Math.floor(Number(v) || 0);
                    if (qty >= 1) {
                      setLines((prev) =>
                        prev.map((l) =>
                          Number(l.productId) === Number(lines[0].productId)
                            ? { ...l, quantity: qty }
                            : l
                        )
                      );
                    }
                  }}
                  keyboardType="number-pad"
                />
              ) : null}
            </Card>
          ) : null}

          {lines.length ? (
            <Card style={styles.gap}>
              <Text style={styles.section}>В документе ({lines.length})</Text>
              {lines.map((l) => (
                <View key={l.productId} style={styles.lineRow}>
                  <Text style={styles.itemTitle}>
                    {l.sku} · {l.quantity} шт
                  </Text>
                  <Button
                    title="Убрать"
                    variant="secondary"
                    small
                    disabled={busy}
                    onPress={() => setLines((prev) => prev.filter((x) => x.productId !== l.productId))}
                  />
                </View>
              ))}
              <Text style={styles.muted}>
                → {destName || '…'}
              </Text>
              <Button
                title={busy ? 'Оформляю…' : 'Создать документ перемещения'}
                onPress={submit}
                loading={busy}
                disabled={!toWarehouseId || !lines.length}
              />
            </Card>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 40 },
  hint: { fontSize: 15, color: colors.muted, lineHeight: 22 },
  gap: { gap: 10 },
  section: { fontSize: 17, fontWeight: '700', color: colors.text },
  muted: { fontSize: 14, color: colors.muted },
  option: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  optionActive: { borderColor: colors.primary, backgroundColor: '#EEF5FF' },
  optionText: { fontSize: 16, color: colors.text },
  optionTextActive: { fontWeight: '700', color: colors.primary },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  itemBlock: { gap: 6, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  itemRow: {
    gap: 4,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  itemRowActive: { borderColor: colors.primary, backgroundColor: '#EEF5FF' },
  itemTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  itemTitleActive: { color: colors.primary },
  lineRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
});
