import { useCallback, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { cargoApi } from '../../../api/erp';
import { errorMessage } from '../../../api/client';
import { writeItem } from '../../../lib/storage';
import { Banner, Field, Loading } from '../../../ui/components';
import { colors } from '../../../ui/theme';

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU');
}

function PurchaseRow({ item }) {
  const open = async () => {
    await writeItem('cargoPurchase', String(item.id));
    router.push(`/cargo/${item.id}`);
  };
  const expected = item.expectedCargoPlaces;
  const placesText =
    item.cargoTotal > 0 || expected != null
      ? `Грузомест: ${item.cargoTotal}${expected != null ? ` из ${expected}` : ''}` +
        (item.cargoTotal > 0 ? ` · разобрано ${item.cargoDone}` : '')
      : 'Грузоместа не приняты';
  return (
    <Pressable onPress={open} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.rowHead}>
        <Text style={styles.title}>№{item.id}</Text>
        <Text style={styles.date}>{formatDate(item.orderedAt || item.createdAt)}</Text>
      </View>
      <Text style={styles.supplier}>{item.supplierName || 'Поставщик не указан'}</Text>
      {item.warehouseName ? <Text style={styles.muted}>Склад: {item.warehouseName}</Text> : null}
      <Text style={styles.muted}>
        Позиций: {item.itemsCount} · ожидается {item.expectedTotal} шт · принято {item.receivedTotal}
      </Text>
      <Text style={[styles.places, item.cargoOpened > 0 && { color: colors.warning }]}>{placesText}</Text>
    </Pressable>
  );
}

export default function CargoPurchasesScreen() {
  const [search, setSearch] = useState('');
  const searchRef = useRef('');
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    (q) =>
      cargoApi.listPurchases(q).then(
        (list) => {
          setItems(list);
          setError(null);
        },
        (e) => {
          setItems((prev) => prev || []);
          setError(errorMessage(e, 'Не удалось загрузить закупки'));
        }
      ),
    []
  );

  useFocusEffect(
    useCallback(() => {
      load(searchRef.current.trim());
    }, [load])
  );

  const changeSearch = (text) => {
    searchRef.current = text;
    setSearch(text);
  };

  const refresh = () => {
    setRefreshing(true);
    load(search.trim()).finally(() => setRefreshing(false));
  };

  if (items === null && !error) return <Loading text="Загружаем закупки…" />;

  return (
    <FlatList
      data={items || []}
      keyExtractor={(item) => String(item.id)}
      renderItem={({ item }) => <PurchaseRow item={item} />}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      ListHeaderComponent={
        <View style={styles.header}>
          <Field
            value={search}
            onChangeText={changeSearch}
            onSubmitEditing={() => load(search.trim())}
            returnKeyType="search"
            placeholder="Номер закупки или поставщик"
            autoCorrect={false}
          />
          <Banner text={error} onClose={() => setError(null)} />
        </View>
      }
      ListEmptyComponent={<Text style={styles.empty}>Открытых закупок нет</Text>}
    />
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  header: { gap: 10 },
  row: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  pressed: { opacity: 0.85 },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  title: { fontSize: 20, fontWeight: '700', color: colors.text },
  date: { fontSize: 14, color: colors.muted },
  supplier: { fontSize: 16, fontWeight: '600', color: colors.text },
  muted: { fontSize: 14, color: colors.muted },
  places: { fontSize: 15, fontWeight: '600', color: colors.primary, marginTop: 4 },
  empty: { textAlign: 'center', color: colors.muted, fontSize: 16, marginTop: 24 },
});
