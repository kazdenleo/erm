import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useAuth } from '../../context/AuthContext';
import { readItem } from '../../lib/storage';
import { colors } from '../../ui/theme';

function Tile({ title, subtitle, onPress, accent }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.tile, { borderLeftColor: accent }, pressed && styles.pressed]}
    >
      <Text style={styles.tileTitle}>{title}</Text>
      {subtitle ? <Text style={styles.tileSubtitle}>{subtitle}</Text> : null}
    </Pressable>
  );
}

export default function HomeScreen() {
  const { user, organization } = useAuth();
  const [activeReceipt, setActiveReceipt] = useState(null);
  const [activePurchase, setActivePurchase] = useState(null);

  useFocusEffect(
    useCallback(() => {
      readItem('receiptSession').then(setActiveReceipt);
      readItem('cargoPurchase').then(setActivePurchase);
    }, [])
  );

  const name = user?.firstName || user?.fullName || user?.email || 'Сотрудник';

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Pressable onPress={() => router.push('/settings')} style={styles.header}>
        <Text style={styles.hello}>Здравствуйте, {name}</Text>
        <Text style={styles.org}>{organization?.name || 'Организация не выбрана'} · настройки</Text>
      </Pressable>

      <Tile
        title="Сборка заказов"
        subtitle="Сканируйте товар — приложение найдёт заказ и покажет, что ещё собрать"
        accent={colors.primary}
        onPress={() => router.push('/assembly')}
      />
      {activePurchase ? (
        <Tile
          title={`Закупка №${activePurchase}`}
          subtitle="Продолжить приёмку грузомест"
          accent={colors.warning}
          onPress={() => router.push(`/cargo/${encodeURIComponent(activePurchase)}`)}
        />
      ) : null}
      <Tile
        title="Приёмка по закупке"
        subtitle="Принять грузоместа, вскрыть каждое и принять товар из него"
        accent={colors.success}
        onPress={() => router.push('/cargo')}
      />
      {activeReceipt ? (
        <Tile
          title="Продолжить приёмку"
          subtitle={`Сессия ${activeReceipt}`}
          accent={colors.warning}
          onPress={() => router.push(`/receipt/${encodeURIComponent(activeReceipt)}`)}
        />
      ) : null}
      <Tile
        title="Приёмка без закупки"
        subtitle="Новая приёмка на склад или подключение к общей приёмке"
        accent={colors.success}
        onPress={() => router.push('/receipt')}
      />
      <View style={styles.spacer} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14 },
  header: { paddingVertical: 8, gap: 4 },
  hello: { fontSize: 22, fontWeight: '700', color: colors.text },
  org: { fontSize: 15, color: colors.primary },
  tile: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 6,
    gap: 6,
  },
  tileTitle: { fontSize: 21, fontWeight: '700', color: colors.text },
  tileSubtitle: { fontSize: 15, color: colors.muted },
  pressed: { opacity: 0.85 },
  spacer: { height: 24 },
});
