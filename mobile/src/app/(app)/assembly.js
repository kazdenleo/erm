import { useMemo } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useAssemblySession } from '../../features/assembly/useAssemblySession';
import { useProductAddresses } from '../../features/addressStorage/useProductAddresses';
import { normalizeMarketplaceForUI, orderStickerCellValue, splitStickerEmphasis } from '../../shared/erpUtils';
import { ScanBar } from '../../components/ScanBar';
import { ProductMeta } from '../../components/ProductMeta';
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

/** Состав группы заказов для списка (из assemblyCompositionLines или строк заказа). */
function compositionLinesForGroup(rows) {
  const lines = [];
  for (const o of rows || []) {
    const warehouseId = o.warehouseId ?? o.warehouse_id ?? null;
    const acl = o.assemblyCompositionLines ?? o.assembly_composition_lines;
    if (Array.isArray(acl) && acl.length) {
      for (const line of acl) {
        const qty = Math.max(1, Number(line.quantity ?? line.qty ?? 1) || 1);
        lines.push({
          key: `${o.orderId}-${line.productId ?? line.product_id ?? line.offerId ?? lines.length}`,
          name: line.productName || line.product_name || line.name || '—',
          attribute: String(line.displayAttributeValue ?? line.display_attribute_value ?? '').trim(),
          article: String(line.article ?? line.sku ?? line.offerId ?? line.orderLineId ?? line.productSku ?? '').trim(),
          productId: Number(line.productId ?? line.product_id) || null,
          warehouseId,
          quantity: qty,
        });
      }
      continue;
    }
    lines.push({
      key: String(o.orderId ?? o.order_id ?? lines.length),
      name: o.productName || o.product_name || '—',
      attribute: String(o.displayAttributeValue ?? o.display_attribute_value ?? '').trim(),
      article: String(o.article ?? o.offerId ?? o.offer_id ?? o.productSku ?? o.product_sku ?? '').trim(),
      productId: Number(o.productId ?? o.product_id) || null,
      warehouseId,
      quantity: Math.max(1, Number(o.quantity) || 1),
    });
  }
  return lines;
}

function CompositionList({ lines, compact = false, addressStorageEnabled = false, codeFor }) {
  if (!lines.length) return null;
  return (
    <View style={compact ? styles.compListCompact : styles.compList}>
      {lines.map((line) => (
        <View key={line.key} style={compact ? styles.compLineCompact : styles.compLine}>
          <View style={styles.flex}>
            <Text style={compact ? styles.compNameCompact : styles.compName} numberOfLines={compact ? 2 : 3}>
              {line.name}
              {line.attribute ? ` · ${line.attribute}` : ''}
            </Text>
            <ProductMeta
              article={line.article}
              locationCode={
                line.locationCode ||
                (codeFor && line.productId ? codeFor(line.productId, line.warehouseId) : null)
              }
              addressStorageEnabled={addressStorageEnabled}
              compact={compact}
            />
          </View>
          <Text style={compact ? styles.compQtyCompact : styles.compQty}>{line.quantity} шт</Text>
        </View>
      ))}
    </View>
  );
}

function CurrentOrder({ session }) {
  const { current, lines, phase, busy, printing, retryFinish, reset, printLabel } = session;
  const { order } = current;
  const done = phase === 'collected';
  const totalNeed = lines.reduce((s, l) => s + l.need, 0);
  const totalScanned = lines.reduce((s, l) => s + l.scanned, 0);
  const storageOn = current?.addressStorageEnabled === true;

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
              <ProductMeta
                article={line.article}
                locationCode={line.locationCode}
                addressStorageEnabled={storageOn}
              />
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

  const listProductIds = useMemo(() => {
    const ids = [];
    for (const g of groups.slice(0, LIST_LIMIT)) {
      for (const line of compositionLinesForGroup(g.rows)) {
        if (line.productId) ids.push(line.productId);
      }
    }
    return ids;
  }, [groups]);
  const addresses = useProductAddresses(listProductIds);

  return (
    <View style={styles.screen}>
      <View style={styles.scanArea}>
        <ScanBar
          onScan={handleScan}
          busy={busy}
          placeholder="Отсканируйте товар"
          cameraHint={current && session.phase === 'collecting' ? 'Сканируйте оставшиеся товары заказа' : null}
        />
      </View>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={ordersLoading} onRefresh={() => reloadOrders()} />}
      >
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

      <Button
        title="Отправить новые заказы на сборку"
        variant="secondary"
        small
        onPress={() => router.push('/send-to-assembly')}
      />

      <Text style={styles.section}>На сборке: {groups.length}</Text>
      {groups.length === 0 && !ordersLoading ? <Text style={styles.muted}>Заказов на сборке нет</Text> : null}
      {groups.slice(0, LIST_LIMIT).map((g) => {
        const composition = compositionLinesForGroup(g.rows);
        const totalQty = composition.reduce((s, l) => s + l.quantity, 0);
        const active = current?.key === g.key;
        return (
          <View key={g.key} style={[styles.listRow, active && styles.listRowActive]}>
            <View style={styles.listHeader}>
              <MarketplaceBadge marketplace={g.primary.marketplace} />
              <Text style={styles.listMeta} numberOfLines={1}>
                {g.primary.orderId} · {totalQty} шт
              </Text>
            </View>
            <Sticker order={g.primary} />
            <CompositionList
              lines={composition}
              compact
              addressStorageEnabled={addresses.enabled}
              codeFor={addresses.codeFor}
            />
          </View>
        );
      })}
      {groups.length > LIST_LIMIT ? (
        <Text style={styles.muted}>…и ещё {groups.length - LIST_LIMIT}</Text>
      ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scanArea: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, backgroundColor: colors.bg, zIndex: 1 },
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
  lineQty: { fontSize: 22, fontWeight: '800', color: colors.text },
  lineQtyDone: { color: colors.success },
  buttonsRow: { flexDirection: 'row', gap: 10 },
  chips: { gap: 8, paddingVertical: 2 },
  section: { fontSize: 18, fontWeight: '700', color: colors.text, marginTop: 4 },
  muted: { fontSize: 15, color: colors.muted },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  listRow: {
    gap: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  listRowActive: { borderColor: colors.primary, borderWidth: 2 },
  listHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  listMeta: { flex: 1, fontSize: 13, color: colors.muted },
  compList: { gap: 6 },
  compListCompact: { gap: 4 },
  compLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    borderRadius: 10,
    backgroundColor: colors.bg,
  },
  compLineCompact: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 4,
  },
  compName: { fontSize: 16, color: colors.text, fontWeight: '500' },
  compNameCompact: { fontSize: 15, color: colors.text, fontWeight: '500' },
  compQty: { fontSize: 18, fontWeight: '800', color: colors.text },
  compQtyCompact: { fontSize: 15, fontWeight: '700', color: colors.text, minWidth: 44, textAlign: 'right' },
});
