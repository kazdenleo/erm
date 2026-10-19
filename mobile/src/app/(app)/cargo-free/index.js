import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useAuth } from '../../../context/AuthContext';
import { cargoBatchesApi, warehousesApi } from '../../../api/erp';
import { errorMessage } from '../../../api/client';
import { writeItem } from '../../../lib/storage';
import { Banner, Button, Card, Loading } from '../../../ui/components';
import { colors } from '../../../ui/theme';

function isOwnWarehouse(w) {
  return w && String(w.type || '').toLowerCase() !== 'supplier' && !w.supplierId && !w.supplier_id;
}

export default function CargoFreeStartScreen() {
  const { organizationId } = useAuth();
  const [warehouses, setWarehouses] = useState(null);
  const [warehouseId, setWarehouseId] = useState(null);
  const [batches, setBatches] = useState([]);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const loadBatches = useCallback(async () => {
    try {
      setBatches(await cargoBatchesApi.list('open'));
      setError(null);
    } catch (e) {
      setError(errorMessage(e, 'Не удалось загрузить пакеты'));
    }
  }, []);

  useEffect(() => {
    warehousesApi.list(organizationId).then(
      (all) => {
        const list = all.filter(isOwnWarehouse);
        setWarehouses(list);
        if (list.length === 1) setWarehouseId(list[0].id);
      },
      (e) => {
        setWarehouses([]);
        setError(errorMessage(e, 'Не удалось загрузить склады'));
      }
    );
  }, [organizationId]);

  useFocusEffect(
    useCallback(() => {
      loadBatches();
    }, [loadBatches])
  );

  const openBatch = async (batchId) => {
    await writeItem('cargoBatch', String(batchId));
    router.push(`/cargo-free/${batchId}`);
  };

  const start = async () => {
    if (!warehouseId) {
      setError('Выберите склад приёмки');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const batch = await cargoBatchesApi.create({
        warehouseId: Number(warehouseId),
        organizationId: organizationId ? Number(organizationId) : null,
      });
      await openBatch(batch.id);
    } catch (e) {
      setError(errorMessage(e, 'Не удалось начать приёмку грузомест'));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    await loadBatches();
    setRefreshing(false);
  };

  const sorted = useMemo(
    () => [...(warehouses || [])].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru')),
    [warehouses]
  );

  if (warehouses === null) return <Loading text="Загружаем склады…" />;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
    >
      <Banner text={error} onClose={() => setError(null)} />

      <Card style={styles.gap}>
        <Text style={styles.section}>Новая приёмка грузомест</Text>
        <Text style={styles.muted}>Сначала примите коробки, затем товар из каждой. Без привязки к закупке.</Text>
        {sorted.length === 0 ? <Text style={styles.muted}>Нет доступных складов</Text> : null}
        {sorted.map((w) => {
          const active = String(w.id) === String(warehouseId);
          return (
            <Pressable
              key={w.id}
              onPress={() => setWarehouseId(w.id)}
              style={[styles.option, active && styles.optionActive]}
            >
              <Text style={[styles.optionText, active && styles.optionTextActive]}>{w.name || `Склад #${w.id}`}</Text>
            </Pressable>
          );
        })}
        <Button title="Начать" onPress={start} loading={busy} disabled={!warehouseId} />
      </Card>

      <Text style={styles.section}>Открытые пакеты</Text>
      {batches.length === 0 ? <Text style={styles.muted}>Нет открытых приёмок грузомест</Text> : null}
      {batches.map((b) => (
        <Pressable key={b.id} onPress={() => openBatch(b.id)} style={({ pressed }) => [styles.batch, pressed && styles.pressed]}>
          <Text style={styles.batchTitle}>Пакет №{b.id}</Text>
          <Text style={styles.muted}>
            {b.warehouseName || `Склад #${b.warehouseId}`} · мест {b.placesCount}
            {b.expectedPlaces != null ? ` из ${b.expectedPlaces}` : ''} · товара {b.scannedTotal} шт
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 40 },
  gap: { gap: 10 },
  section: { fontSize: 18, fontWeight: '700', color: colors.text },
  muted: { fontSize: 14, color: colors.muted },
  option: { padding: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  optionActive: { borderColor: colors.primary, backgroundColor: '#EFF4FF' },
  optionText: { fontSize: 16, color: colors.text },
  optionTextActive: { color: colors.primary, fontWeight: '600' },
  batch: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    gap: 4,
  },
  batchTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  pressed: { opacity: 0.85 },
});
