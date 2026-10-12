import { Stack } from 'expo-router';
import { colors } from '../../ui/theme';

export default function AppLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.card },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '600' },
        contentStyle: { backgroundColor: colors.bg },
        headerBackTitle: 'Назад',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'ERM Склад' }} />
      <Stack.Screen name="assembly" options={{ title: 'Сборка заказов' }} />
      <Stack.Screen name="receipt/index" options={{ title: 'Приёмка' }} />
      <Stack.Screen name="receipt/[sessionId]" options={{ title: 'Приёмка' }} />
      <Stack.Screen name="cargo/index" options={{ title: 'Приёмка по закупке' }} />
      <Stack.Screen name="cargo/[purchaseId]" options={{ title: 'Закупка' }} />
      <Stack.Screen name="cargo/place/[placeId]" options={{ title: 'Грузоместо' }} />
      <Stack.Screen name="settings" options={{ title: 'Настройки' }} />
    </Stack>
  );
}
