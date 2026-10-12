import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../../context/AuthContext';
import { productsApi, receiptsApi, suppliersApi } from '../../../api/erp';
import { errorMessage } from '../../../api/client';
import { scanError, scanOk } from '../../../lib/feedback';
import { writeItem } from '../../../lib/storage';
import { ScanBar } from '../../../components/ScanBar';
import { Banner, Button, Card, Chip, Field, Loading } from '../../../ui/components';
import { colors } from '../../../ui/theme';

const POLL_MS = 3000;
const MULTIPLIERS = [1, 5, 10, 20];
const SUPPLIERS_LIMIT = 30;

function SupplierPicker({ onCancel, onConfirm, busy }) {
  const [suppliers, setSuppliers] = useState(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    suppliersApi
      .list()
      .then(setSuppliers)
      .catch((e) => {
        setSuppliers([]);
        setError(errorMessage(e, 'Не удалось загрузить поставщиков'));
      });
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = suppliers || [];
    return (q ? list.filter((s) => String(s.name || '').toLowerCase().includes(q)) : list).slice(0, SUPPLIERS_LIMIT);
  }, [suppliers, query]);

  return (
    <Card style={styles.gap}>
      <Text style={styles.section}>Поставщик</Text>
      <Banner text={error} />
      <Field value={query} onChangeText={setQuery} placeholder="Поиск поставщика" autoCorrect={false} />
      {suppliers === null ? <Text style={styles.muted}>Загрузка…</Text> : null}
      {filtered.map((s) => {
        const active = String(s.id) === String(selected);
        return (
          <Pressable key={s.id} onPress={() => setSelected(s.id)} style={[styles.option, active && styles.optionActive]}>
            <Text style={[styles.optionText, active && styles.optionTextActive]}>{s.name || `#${s.id}`}</Text>
          </Pressable>
        );
      })}
      <View style={styles.row}>
        <Button title="Отмена" variant="secondary" style={styles.flex} onPress={onCancel} />
        <Button
          title="Оформить"
          style={styles.flex}
          disabled={!selected}
          loading={busy}
          onPress={() => onConfirm(Number(selected))}
        />
      </View>
    </Card>
  );
}

export default function ReceiptSessionScreen() {
  const { sessionId } = useLocalSearchParams();
  const sid = String(sessionId || '');
  const { user, organizationId } = useAuth();
  const [session, setSession] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [multiplier, setMultiplier] = useState(1);
  const [completing, setCompleting] = useState(false);
  const [completeBusy, setCompleteBusy] = useState(false);
  const busyRef = useRef(false);

  const forget = useCallback(async () => {
    await writeItem('receiptSession', null);
  }, []);

  const refresh = useCallback(
    () =>
      receiptsApi.getSession(sid).then(
        (data) => {
          setSession(data);
          setLoadError(null);
        },
        (e) => {
          if (e?.status === 404) forget();
          setLoadError(errorMessage(e, 'Не удалось загрузить приёмку'));
        }
      ),
    [sid, forget]
  );

  useEffect(() => {
    refresh();
    const t = setInterval(() => {
      if (!busyRef.current) refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const runBusy = async (fn) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleScan = (code) =>
    runBusy(async () => {
      setMessage(null);
      try {
        const product = await productsApi.byBarcode(code);
        const cost = product?.cost != null && product.cost !== '' && Number.isFinite(Number(product.cost)) ? Number(product.cost) : null;
        const next = await receiptsApi.addQuantity(sid, { code: String(product.id), quantity: multiplier, cost });
        setSession(next);
        setMessage({ kind: 'success', text: `+${multiplier} · ${product.name || product.sku || code}` });
        setMultiplier(1);
        scanOk();
      } catch (e) {
        setMessage({ kind: 'error', text: `${code}: ${errorMessage(e, 'Товар не найден')}` });
        scanError();
      }
    });

  const changeQuantity = (item, quantity) =>
    runBusy(async () => {
      try {
        setSession(await receiptsApi.setQuantity(sid, item.productId, quantity));
      } catch (e) {
        setMessage({ kind: 'error', text: errorMessage(e) });
      }
    });

  const confirmRemove = (item) =>
    Alert.alert('Убрать позицию?', item.name, [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Убрать', style: 'destructive', onPress: () => changeQuantity(item, 0) },
    ]);

  const complete = async (supplierId) => {
    setCompleteBusy(true);
    try {
      const res = await receiptsApi.complete(sid, { supplierId, organizationId: organizationId ? Number(organizationId) : null });
      await forget();
      const number = res?.receipt?.receipt_number;
      Alert.alert('Приёмка оформлена', number ? `Документ ${number}` : 'Товар оприходован на склад');
      router.replace('/');
    } catch (e) {
      setMessage({ kind: 'error', text: errorMessage(e, 'Не удалось оформить приёмку') });
    } finally {
      setCompleteBusy(false);
    }
  };

  const leave = () =>
    Alert.alert('Выйти из приёмки?', 'Сессия сохранится на сервере на сутки — к ней можно вернуться по коду.', [
      { text: 'Остаться', style: 'cancel' },
      {
        text: 'Выйти',
        onPress: async () => {
          await forget();
          router.replace('/');
        },
      },
    ]);

  if (!session && !loadError) return <Loading text="Загружаем приёмку…" />;

  if (!session) {
    return (
      <View style={styles.content}>
        <Banner text={loadError} />
        <Button title="На главную" variant="secondary" onPress={() => router.replace('/')} />
      </View>
    );
  }

  const items = session.items || [];
  const totalQty = items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  const isOwner = user?.id != null && Number(session.ownerUserId) === Number(user.id);

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Pressable onPress={() => Share.share({ message: sid })} style={styles.sessionInfo}>
        <Text style={styles.muted}>Код сессии (нажмите, чтобы поделиться)</Text>
        <Text style={styles.sessionCode}>{sid}</Text>
      </Pressable>

      <ScanBar onScan={handleScan} busy={busy} placeholder="Отсканируйте товар" />
      <View style={styles.multipliers}>
        <Text style={styles.muted}>Количество за скан:</Text>
        {MULTIPLIERS.map((m) => (
          <Chip key={m} label={`×${m}`} active={multiplier === m} onPress={() => setMultiplier(m)} />
        ))}
      </View>
      <Banner kind={message?.kind} text={message?.text} onClose={() => setMessage(null)} />
      {loadError ? <Banner kind="warning" text={`Нет связи: ${loadError}`} /> : null}

      <Text style={styles.section}>
        Позиций: {items.length} · Штук: {totalQty}
      </Text>
      {items.length === 0 ? <Text style={styles.muted}>Пока ничего не отсканировано</Text> : null}
      {items.map((item) => (
        <View key={item.productId} style={styles.item}>
          <View style={styles.flex}>
            <Text style={styles.itemName}>{item.name}</Text>
            <Text style={styles.itemSku}>{item.sku}</Text>
          </View>
          <Pressable
            style={styles.qtyButton}
            onPress={() => (item.quantity <= 1 ? confirmRemove(item) : changeQuantity(item, item.quantity - 1))}
          >
            <Text style={styles.qtyButtonText}>−</Text>
          </Pressable>
          <Text style={styles.itemQty}>{item.quantity}</Text>
          <Pressable style={styles.qtyButton} onPress={() => changeQuantity(item, item.quantity + 1)}>
            <Text style={styles.qtyButtonText}>+</Text>
          </Pressable>
        </View>
      ))}

      {completing ? (
        <SupplierPicker busy={completeBusy} onCancel={() => setCompleting(false)} onConfirm={complete} />
      ) : (
        <View style={styles.gap}>
          {isOwner ? (
            <Button title="Оформить приёмку" disabled={items.length === 0} onPress={() => setCompleting(true)} />
          ) : (
            <Text style={styles.muted}>Оформить документ может только создатель приёмки.</Text>
          )}
          <Button title="Выйти из приёмки" variant="secondary" onPress={leave} />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  gap: { gap: 10 },
  flex: { flex: 1 },
  row: { flexDirection: 'row', gap: 10 },
  section: { fontSize: 18, fontWeight: '700', color: colors.text },
  muted: { fontSize: 14, color: colors.muted },
  sessionInfo: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
  },
  sessionCode: { fontSize: 20, fontWeight: '700', color: colors.text, letterSpacing: 1 },
  multipliers: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  itemName: { fontSize: 16, color: colors.text, fontWeight: '500' },
  itemSku: { fontSize: 13, color: colors.muted, marginTop: 2 },
  itemQty: { fontSize: 22, fontWeight: '800', color: colors.text, minWidth: 36, textAlign: 'center' },
  qtyButton: {
    width: 44,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  qtyButtonText: { fontSize: 24, fontWeight: '600', color: colors.text },
  option: { padding: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  optionActive: { borderColor: colors.primary, backgroundColor: '#EFF4FF' },
  optionText: { fontSize: 16, color: colors.text },
  optionTextActive: { color: colors.primary, fontWeight: '600' },
});
