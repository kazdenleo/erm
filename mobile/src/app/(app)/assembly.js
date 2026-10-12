import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAssemblySession } from '../../features/assembly/useAssemblySession';
import { normalizeMarketplaceForUI, orderStickerCellValue, splitStickerEmphasis } from '../../shared/erpUtils';
import { ScanBar } from '../../components/ScanBar';
import { Banner, Button, Card, Chip } from '../../ui/components';
import { colors, marketplaceColors, marketplaceLabels } from '../../ui/theme';

const FILTERS = ['all', 'ozon', 'wildberries', 'yandex'];
const LIST_LIMIT = 50;

function MarketplaceBadge({ marketplace }) {
  const mp = normalizeMarketplaceForUI(marketplace);
  return (
    <View style={[styles.badge, { backgroundColor: marketplaceColors[mp] || colors.muted }]}>
      <Text style={styles.badgeText}>{marketplaceLabels[mp] || mp}</Text>
    </View>
  );
}

function Sticker({ order }) {
  const value = orderStickerCellValue({ ...order, status: 'in_assembly' });
  if (!value || value === '—') return <Text style={styles.stickerMissing}>Стикера нет</Text>;
  const parts = splitStickerEmphasis(value);
  return (
    <Text style={styles.sticker}>
      Стикер: {parts?.prefix}
      <Text style={styles.stickerBold}>{parts?.suffix}</Text>
    </Text>
  );
}

function CurrentOrder({ session }) {
  const { current, lines, phase, busy, printing, retryFinish, reset, printLabel } = session;
  const { order } = current;
  const done = phase === 'collected';
  const totalNeed = lines.reduce((s, l) => s + l.need, 0);
  const totalScanned = lines.reduce((s, l) => s + l.scanned, 0);

  return (
    <Card style={[styles.gap, done && styles.cardDone]}>
      <View style={styles.rowBetween}>
        <MarketplaceBadge marketplace={order.marketplace} />
        <Text style={styles.orderId} numberOfLines={1}>
          {order.orderId}
        </Text>
      </View>
      <Sticker order={order} />

      {done ? (
        <Text style={styles.doneText}>Собран — упакуйте и наклейте этикетку</Text>
      ) : (
        <Text style={styles.progress}>
          Собрано {totalScanned} из {totalNeed}
        </Text>
      )}

      {lines.map((line) => {
        const lineDone = line.scanned >= line.need;
        return (
          <View key={line.key} style={[styles.line, lineDone && styles.lineDone]}>
            <View style={styles.lineInfo}>
              <Text style={styles.lineName}>
                {line.name}
                {line.attribute ? ` · ${line.attribute}` : ''}
              </Text>
              {line.article ? <Text style={styles.lineArticle}>{line.article}</Text> : null}
            </View>
            <Text style={[styles.lineQty, lineDone && styles.lineQtyDone]}>
              {line.scanned}/{line.need}
            </Text>
          </View>
        );
      })}

      {phase === 'finishing' ? <Text style={styles.muted}>Отмечаем сборку на сервере…</Text> : null}
      {phase === 'finishFailed' ? (
        <Button title="Повторить завершение" onPress={retryFinish} loading={busy} />
      ) : null}
      <View style={styles.buttonsRow}>
        {done ? (
          <Button
            title="Печать этикетки"
            style={styles.flex}
            loading={printing}
            onPress={() => printLabel(order.orderId)}
          />
        ) : null}
        <Button title={done ? 'Следующий' : 'Сбросить'} variant="secondary" style={styles.flex} onPress={reset} />
      </View>
    </Card>
  );
}

export default function AssemblyScreen() {
  const session = useAssemblySession();
  const {
    groups,
    countsByMarketplace,
    ordersLoading,
    ordersError,
    reloadOrders,
    marketplace,
    setMarketplace,
    current,
    message,
    clearMessage,
    busy,
    handleScan,
  } = session;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={ordersLoading} onRefresh={() => reloadOrders()} />}
    >
      <ScanBar
        onScan={handleScan}
        busy={busy}
        placeholder="Отсканируйте товар"
        cameraHint={current && session.phase === 'collecting' ? 'Сканируйте оставшиеся товары заказа' : null}
      />
      <Banner kind={message?.kind} text={message?.text} onClose={clearMessage} />

      {current ? <CurrentOrder session={session} /> : null}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {FILTERS.map((mp) => (
          <Chip
            key={mp}
            label={`${mp === 'all' ? 'Все' : marketplaceLabels[mp]} ${countsByMarketplace[mp] || 0}`}
            active={marketplace === mp}
            color={marketplaceColors[mp]}
            onPress={() => setMarketplace(mp)}
          />
        ))}
      </ScrollView>

      <Banner text={ordersError} onClose={() => reloadOrders()} />

      <Text style={styles.section}>На сборке: {groups.length}</Text>
      {groups.length === 0 && !ordersLoading ? <Text style={styles.muted}>Заказов на сборке нет</Text> : null}
      {groups.slice(0, LIST_LIMIT).map((g) => {
        const qty = g.rows.reduce((s, o) => s + (Number(o.quantity) || 1), 0);
        const active = current?.key === g.key;
        return (
          <View key={g.key} style={[styles.listRow, active && styles.listRowActive]}>
            <MarketplaceBadge marketplace={g.primary.marketplace} />
            <View style={styles.flex}>
              <Text style={styles.listName} numberOfLines={2}>
                {g.rows.map((o) => o.productName || o.product_name).filter(Boolean).join(', ') || g.primary.orderId}
              </Text>
              <Text style={styles.listMeta}>
                {g.primary.orderId} · {qty} шт
              </Text>
            </View>
          </View>
        );
      })}
      {groups.length > LIST_LIMIT ? (
        <Text style={styles.muted}>…и ещё {groups.length - LIST_LIMIT}</Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  gap: { gap: 10 },
  flex: { flex: 1 },
  cardDone: { borderColor: colors.success, borderWidth: 2 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  orderId: { flex: 1, fontSize: 18, fontWeight: '700', color: colors.text },
  sticker: { fontSize: 18, color: colors.text },
  stickerBold: { fontWeight: '800', fontSize: 22 },
  stickerMissing: { fontSize: 15, color: colors.warning },
  progress: { fontSize: 16, color: colors.muted },
  doneText: { fontSize: 17, fontWeight: '700', color: colors.success },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 10,
    backgroundColor: colors.bg,
  },
  lineDone: { backgroundColor: colors.successBg },
  lineInfo: { flex: 1, gap: 2 },
  lineName: { fontSize: 16, color: colors.text, fontWeight: '500' },
  lineArticle: { fontSize: 13, color: colors.muted },
  lineQty: { fontSize: 22, fontWeight: '800', color: colors.text },
  lineQtyDone: { color: colors.success },
  buttonsRow: { flexDirection: 'row', gap: 10 },
  chips: { gap: 8, paddingVertical: 2 },
  section: { fontSize: 18, fontWeight: '700', color: colors.text, marginTop: 4 },
  muted: { fontSize: 15, color: colors.muted },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  listRowActive: { borderColor: colors.primary, borderWidth: 2 },
  listName: { fontSize: 15, color: colors.text },
  listMeta: { fontSize: 13, color: colors.muted, marginTop: 2 },
});
