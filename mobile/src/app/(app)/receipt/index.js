import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../../../context/AuthContext';
import { receiptsApi, warehousesApi } from '../../../api/erp';
import { errorMessage } from '../../../api/client';
import { writeItem } from '../../../lib/storage';
import { Banner, Button, Card, Field, Loading } from '../../../ui/components';
import { colors } from '../../../ui/theme';

/** Приёмка — только на собственные склады (не склады поставщиков), как в веб-разделе «Склад». */
function isOwnWarehouse(w) {
  return w && String(w.type || '').toLowerCase() !== 'supplier' && !w.supplierId && !w.supplier_id;
}

export default function ReceiptStartScreen() {
  const { organizationId } = useAuth();
  const [warehouses, setWarehouses] = useState(null);
  const [warehouseId, setWarehouseId] = useState(null);
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    warehousesApi.list(organizationId).then(
      (all) => {
        const list = all.filter(isOwnWarehouse);
        setWarehouses(list);
        setError(null);
        if (list.length === 1) setWarehouseId(list[0].id);
      },
      (e) => {
        setWarehouses([]);
        setError(errorMessage(e, 'Не удалось загрузить склады'));
      }
    );
  }, [organizationId]);

  const openSession = async (sessionId) => {
    await writeItem('receiptSession', sessionId);
    router.replace(`/receipt/${encodeURIComponent(sessionId)}`);
  };

  const start = async () => {
    if (!warehouseId) {
      setError('Выберите склад приёмки');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await receiptsApi.createSession(Number(warehouseId));
      await openSession(session.sessionId);
    } catch (e) {
      setError(errorMessage(e, 'Не удалось начать приёмку'));
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    const code = joinCode.trim();
    if (!code) return;
    setBusy(true);
    setError(null);
    try {
      const session = await receiptsApi.getSession(code);
      await openSession(session.sessionId);
    } catch (e) {
      setError(errorMessage(e, 'Сессия не найдена'));
    } finally {
      setBusy(false);
    }
  };

  const sorted = useMemo(
    () => [...(warehouses || [])].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru')),
    [warehouses]
  );

  if (warehouses === null) return <Loading text="Загружаем склады…" />;

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Banner text={error} onClose={() => setError(null)} />

      <Card style={styles.gap}>
        <Text style={styles.section}>Новая приёмка</Text>
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
        <Button title="Начать приёмку" onPress={start} loading={busy} disabled={!warehouseId} />
      </Card>

      <Card style={styles.gap}>
        <Text style={styles.section}>Подключиться к общей приёмке</Text>
        <Text style={styles.muted}>
          Код сессии есть в веб-версии в адресе общей приёмки (параметр session) или у коллеги в приложении.
        </Text>
        <Field value={joinCode} onChangeText={setJoinCode} placeholder="Код сессии" autoCapitalize="none" autoCorrect={false} />
        <Button title="Подключиться" variant="secondary" onPress={join} disabled={!joinCode.trim() || busy} />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14 },
  gap: { gap: 10 },
  section: { fontSize: 18, fontWeight: '700', color: colors.text },
  muted: { fontSize: 14, color: colors.muted },
  option: { padding: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  optionActive: { borderColor: colors.primary, backgroundColor: '#EFF4FF' },
  optionText: { fontSize: 16, color: colors.text },
  optionTextActive: { color: colors.primary, fontWeight: '600' },
});
