/**
 * Межскладское перемещение в ячейку: скан ячейки назначения → товар → склад-источник → ПМ.
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

export default function AddressTransferScreen() {
  const { organizationId } = useAuth();
  const busyRef = useRef(false);
  const [warehouses, setWarehouses] = useState(null);
  const [toWarehouseId, setToWarehouseId] = useState(null);
  const [fromWarehouseId, setFromWarehouseId] = useState(null);
  const [toLocation, setToLocation] = useState(null);
  const [product, setProduct] = useState(null);
  const [productInfo, setProductInfo] = useState(null);
  const [qty, setQty] = useState('1');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [expect, setExpect] = useState('cell'); // cell | product

  useEffect(() => {
    addressStorageApi.listWarehouses().then(
      (all) => {
        const list = (all || []).filter(
          (w) => organizationId == null || Number(w.organizationId) === Number(organizationId)
        );
        setWarehouses(list);
        const dest = list.filter((w) => w.settings?.enabled && w.settings?.trackQuantities);
        if (dest.length === 1) setToWarehouseId(dest[0].id);
      },
      (e) => {
        setWarehouses([]);
        setMessage({ kind: 'error', text: errorMessage(e, 'Не удалось загрузить склады') });
      }
    );
  }, [organizationId]);

  const destWarehouses = useMemo(
    () => (warehouses || []).filter((w) => w.settings?.enabled && w.settings?.trackQuantities),
    [warehouses]
  );

  const sourceWarehouses = useMemo(
    () =>
      (warehouses || []).filter(
        (w) =>
          Number(w.id) !== Number(toWarehouseId) &&
          Number(w.organizationId) ===
            Number((warehouses || []).find((x) => Number(x.id) === Number(toWarehouseId))?.organizationId)
      ),
    [warehouses, toWarehouseId]
  );

  const sourceAvailable = useMemo(() => {
    if (!productInfo || !fromWarehouseId) return 0;
    const wh = (productInfo.warehouses || []).find(
      (w) => Number(w.warehouseId) === Number(fromWarehouseId)
    );
    return wh?.warehouseQty ?? 0;
  }, [productInfo, fromWarehouseId]);

  const resetLine = useCallback(() => {
    setToLocation(null);
    setProduct(null);
    setProductInfo(null);
    setQty('1');
    setExpect('cell');
  }, []);

  useEffect(() => {
    resetLine();
    setFromWarehouseId(null);
    setMessage(null);
  }, [toWarehouseId, resetLine]);

  useEffect(() => {
    if (!fromWarehouseId && sourceWarehouses.length === 1) {
      setFromWarehouseId(sourceWarehouses[0].id);
    }
  }, [fromWarehouseId, sourceWarehouses]);

  const loadProduct = useCallback(
    async (p) => {
      setProduct(p);
      const info = await addressStorageApi.productLocations(p.id);
      setProductInfo(info);
      const others = (info?.warehouses || []).filter(
        (w) => Number(w.warehouseId) !== Number(toWarehouseId) && (w.warehouseQty || 0) > 0
      );
      if (others[0]) {
        setFromWarehouseId(others[0].warehouseId);
        setQty(String(Math.min(others[0].warehouseQty, Math.max(1, Number(qty) || 1))));
      }
      setExpect('cell');
    },
    [toWarehouseId, qty]
  );

  const handleScan = useCallback(
    async (raw) => {
      const code = String(raw || '').trim();
      if (!code || !toWarehouseId || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const r = await addressStorageApi.resolveScan(toWarehouseId, code);
        if (!r) {
          scanError();
          setMessage({ kind: 'error', text: 'Не распознано: ячейка или товар' });
          return;
        }
        if (r.type === 'location' || r.location) {
          scanOk();
          setToLocation(r.location);
          setExpect('product');
          return;
        }
        if (r.type === 'product' || r.product) {
          scanOk();
          await loadProduct({ id: r.product.id, sku: r.product.sku, name: r.product.name });
          return;
        }
        scanError();
        setMessage({ kind: 'error', text: 'Не распознано' });
      } catch (e) {
        scanError();
        setMessage({ kind: 'error', text: errorMessage(e, 'Ошибка скана') });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [toWarehouseId, loadProduct]
  );

  const submit = async () => {
    if (!toLocation?.id) {
      setMessage({ kind: 'error', text: 'Отсканируйте ячейку назначения' });
      return;
    }
    if (!product?.id) {
      setMessage({ kind: 'error', text: 'Отсканируйте товар' });
      return;
    }
    if (!fromWarehouseId) {
      setMessage({ kind: 'error', text: 'Выберите склад-источник' });
      return;
    }
    const quantity = Math.floor(Number(qty) || 0);
    if (quantity < 1) {
      setMessage({ kind: 'error', text: 'Укажите количество' });
      return;
    }
    if (quantity > sourceAvailable) {
      setMessage({ kind: 'error', text: `На складе-источнике только ${sourceAvailable} шт` });
      return;
    }
    const dest = (warehouses || []).find((w) => Number(w.id) === Number(toWarehouseId));
    const orgId = dest?.organizationId || organizationId;
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
        lines: [
          {
            productId: product.id,
            quantity,
            toLocationId: Number(toLocation.id),
          },
        ],
      });
      const receipt = res?.receipt || res;
      const num = receipt?.receipt_number || receipt?.receiptNumber || '';
      const placed = (res?.placements || [])[0];
      scanOk();
      setMessage({
        kind: 'success',
        text: `ПМ ${num || ''} · ${quantity} шт → ${placed?.code || toLocation.code}`.trim(),
      });
      setProduct(null);
      setProductInfo(null);
      setQty('1');
      setExpect(toLocation ? 'product' : 'cell');
    } catch (e) {
      scanError();
      setMessage({ kind: 'error', text: errorMessage(e, 'Не удалось оформить перемещение') });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (warehouses === null) return <Loading text="Загружаем склады…" />;

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.hint}>
        Выберите склад «куда», отсканируйте ячейку и товар, укажите склад «откуда» и количество — создаётся
        документ перемещения, товар сразу ложится в ячейку.
      </Text>

      <Banner kind={message?.kind} text={message?.text} onClose={() => setMessage(null)} />

      <Card style={styles.gap}>
        <Text style={styles.section}>Склад куда</Text>
        {destWarehouses.length === 0 ? (
          <Text style={styles.muted}>Нет складов с учётом количества по ячейкам</Text>
        ) : (
          destWarehouses.map((w) => {
            const active = String(w.id) === String(toWarehouseId);
            return (
              <Pressable
                key={w.id}
                onPress={() => setToWarehouseId(w.id)}
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

      {toWarehouseId ? (
        <>
          <ScanBar
            onScan={handleScan}
            busy={busy}
            placeholder={
              expect === 'cell' ? 'Сканируйте ячейку куда' : 'Сканируйте товар (или снова ячейку)'
            }
          />

          <Card style={styles.gap}>
            <Text style={styles.section}>Ячейка куда</Text>
            <Text style={styles.value}>
              {toLocation ? toLocation.code : '— отсканируйте штрихкод ячейки'}
            </Text>

            <Text style={styles.section}>Товар</Text>
            {product ? (
              <View>
                <Text style={styles.value}>
                  {product.sku} · {product.name}
                </Text>
                <Button
                  title="Сменить товар"
                  variant="secondary"
                  small
                  onPress={() => {
                    setProduct(null);
                    setProductInfo(null);
                    setExpect('product');
                  }}
                />
              </View>
            ) : (
              <Text style={styles.muted}>Отсканируйте штрихкод товара</Text>
            )}

            <Text style={styles.section}>Склад откуда</Text>
            {sourceWarehouses.length === 0 ? (
              <Text style={styles.muted}>Нет другого склада той же организации</Text>
            ) : (
              sourceWarehouses.map((w) => {
                const active = String(w.id) === String(fromWarehouseId);
                const stock =
                  productInfo?.warehouses?.find((x) => Number(x.warehouseId) === Number(w.id))
                    ?.warehouseQty ?? null;
                return (
                  <Pressable
                    key={w.id}
                    onPress={() => setFromWarehouseId(w.id)}
                    style={[styles.option, active && styles.optionActive]}
                  >
                    <Text style={[styles.optionText, active && styles.optionTextActive]}>
                      {w.name}
                      {stock != null ? ` · ${stock} шт` : ''}
                    </Text>
                  </Pressable>
                );
              })
            )}

            <Field
              label="Количество"
              value={qty}
              onChangeText={setQty}
              keyboardType="number-pad"
              placeholder="шт"
            />
            {product && fromWarehouseId ? (
              <Text style={styles.muted}>Доступно на источнике: {sourceAvailable} шт</Text>
            ) : null}

            <Button
              title={busy ? 'Оформляю…' : 'Оформить перемещение'}
              onPress={submit}
              loading={busy}
              disabled={
                !toLocation ||
                !product ||
                !fromWarehouseId ||
                Math.floor(Number(qty) || 0) < 1
              }
            />
            <Button title="Сбросить" variant="secondary" onPress={resetLine} disabled={busy} />
          </Card>
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 40 },
  hint: { fontSize: 15, color: colors.muted, lineHeight: 22 },
  gap: { gap: 10 },
  section: { fontSize: 17, fontWeight: '700', color: colors.text, marginTop: 4 },
  value: { fontSize: 16, color: colors.text },
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
});
