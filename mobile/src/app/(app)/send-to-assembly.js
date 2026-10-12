import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { ordersApi } from '../../api/erp';
import { errorMessage } from '../../api/client';
import { assemblySessionKey } from '../../features/assembly/useAssemblySession';
import { normalizeMarketplaceForUI } from '../../shared/erpUtils';
import { Banner, Button, Chip, Loading } from '../../ui/components';
import { colors, marketplaceColors, marketplaceLabels } from '../../ui/theme';

const FILTERS = ['all', 'ozon', 'wildberries', 'yandex', 'manual'];
const STATUSES = ['new', 'in_procurement'];
const STATUS_LABELS = { new: 'Новый', in_procurement: 'В закупке' };
const LIST_LIMIT = 200;

function groupOrders(rows) {
  const keys = [];
  const byKey = new Map();
  for (const o of rows) {
    const k = assemblySessionKey(o);
    if (!byKey.has(k)) {
      byKey.set(k, []);
      keys.push(k);
    }
    byKey.get(k).push(o);
  }
  return keys.map((k) => {
    const items = byKey.get(k);
    return {
      key: k,
      rows: items,
      primary: items[0],
      marketplace: normalizeMarketplaceForUI(items[0].marketplace),
      status: String(items[0].status || ''),
      createdAt: items[0].createdAt || items[0].created_at || null,
    };
  });
}

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function GroupRow({ group, selected, onToggle }) {
  const qty = group.rows.reduce((s, o) => s + (Number(o.quantity) || 1), 0);
  const names = group.rows.map((o) => o.productName || o.product_name).filter(Boolean);
  return (
    <Pressable onPress={onToggle} style={[styles.row, selected && styles.rowSelected]}>
      <View style={[styles.check, selected && styles.checkOn]}>
        {selected ? <Text style={styles.checkMark}>✓</Text> : null}
      </View>
      <View style={styles.flex}>
        <View style={styles.rowHead}>
          <View style={[styles.badge, { backgroundColor: marketplaceColors[group.marketplace] || colors.muted }]}>
            <Text style={styles.badgeText}>{marketplaceLabels[group.marketplace] || group.marketplace}</Text>
          </View>
          <Text style={styles.orderId} numberOfLines={1}>
            {group.primary.orderId}
          </Text>
        </View>
        <Text style={styles.names} numberOfLines={2}>
          {names.join(', ') || 'Товар не указан'}
        </Text>
        <Text style={styles.meta}>
          {qty} шт · {STATUS_LABELS[group.status] || group.status}
          {group.createdAt ? ` · ${formatDate(group.createdAt)}` : ''}
        </Text>
      </View>
    </Pressable>
  );
}

export default function SendToAssemblyScreen() {
  const [orders, setOrders] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [marketplace, setMarketplace] = useState('all');
  const [selected, setSelected] = useState(() => new Set());
  const [sending, setSending] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    return Promise.all(STATUSES.map((s) => ordersApi.listByStatus(s).catch((e) => ({ error: e }))))
      .then((results) => {
        const failed = results.find((r) => r?.error);
        const list = results.filter(Array.isArray).flat();
        setOrders(list);
        setError(failed && !list.length ? errorMessage(failed.error, 'Не удалось загрузить заказы') : null);
        setSelected((prev) => {
          const alive = new Set(list.map(assemblySessionKey));
          return new Set([...prev].filter((k) => alive.has(k)));
        });
      })
      .finally(() => setLoading(false));
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const groups = useMemo(() => groupOrders(orders || []), [orders]);
  const counts = useMemo(() => {
    const c = { all: groups.length };
    for (const g of groups) c[g.marketplace] = (c[g.marketplace] || 0) + 1;
    return c;
  }, [groups]);
  const visible = useMemo(
    () => (marketplace === 'all' ? groups : groups.filter((g) => g.marketplace === marketplace)),
    [groups, marketplace]
  );
  const visibleSelected = visible.filter((g) => selected.has(g.key));
  const allVisibleSelected = visible.length > 0 && visibleSelected.length === visible.length;

  const toggle = (key) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const g of visible) {
        if (allVisibleSelected) next.delete(g.key);
        else next.add(g.key);
      }
      return next;
    });

  const send = async () => {
    const chosen = groups.filter((g) => selected.has(g.key));
    const items = chosen.flatMap((g) => g.rows.map((o) => ({ marketplace: o.marketplace, orderId: o.orderId })));
    if (!items.length) return;
    setSending(true);
    setMessage(null);
    try {
      const res = await ordersApi.sendToAssembly(items);
      const warnings = (res?.warnings || []).map((w) => w?.message).filter(Boolean);
      setMessage({
        kind: warnings.length ? 'warning' : 'success',
        text: [`На сборку отправлено заказов: ${chosen.length}.`, ...warnings].join('\n'),
      });
      setSelected(new Set());
      await load();
    } catch (e) {
      setMessage({ kind: 'error', text: errorMessage(e, 'Не удалось отправить на сборку') });
    } finally {
      setSending(false);
    }
  };

  if (orders === null && !error) return <Loading text="Загружаем новые заказы…" />;

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {FILTERS.filter((mp) => mp === 'all' || counts[mp]).map((mp) => (
            <Chip
              key={mp}
              label={`${mp === 'all' ? 'Все' : marketplaceLabels[mp]} ${counts[mp] || 0}`}
              active={marketplace === mp}
              color={marketplaceColors[mp]}
              onPress={() => setMarketplace(mp)}
            />
          ))}
        </ScrollView>

        <Banner text={error} onClose={() => setError(null)} />
        <Banner kind={message?.kind} text={message?.text} onClose={() => setMessage(null)} />
        {message?.kind === 'success' || message?.kind === 'warning' ? (
          <Button title="Перейти к сборке" variant="secondary" onPress={() => router.replace('/assembly')} />
        ) : null}

        {visible.length > 0 ? (
          <Pressable onPress={toggleAll} style={styles.selectAll}>
            <View style={[styles.check, allVisibleSelected && styles.checkOn]}>
              {allVisibleSelected ? <Text style={styles.checkMark}>✓</Text> : null}
            </View>
            <Text style={styles.selectAllText}>Выбрать все ({visible.length})</Text>
          </Pressable>
        ) : (
          <Text style={styles.empty}>Новых заказов нет</Text>
        )}

        {visible.slice(0, LIST_LIMIT).map((g) => (
          <GroupRow key={g.key} group={g} selected={selected.has(g.key)} onToggle={() => toggle(g.key)} />
        ))}
        {visible.length > LIST_LIMIT ? (
          <Text style={styles.empty}>…и ещё {visible.length - LIST_LIMIT}. Сузьте список фильтром.</Text>
        ) : null}
      </ScrollView>

      {selected.size > 0 ? (
        <View style={styles.footer}>
          <Button title={`Отправить на сборку (${selected.size})`} loading={sending} onPress={send} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, gap: 10, paddingBottom: 100 },
  chips: { gap: 8, paddingVertical: 2 },
  flex: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowSelected: { borderColor: colors.primary, backgroundColor: '#EFF4FF' },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  check: {
    width: 28,
    height: 28,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  checkOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkMark: { color: colors.primaryText, fontSize: 17, fontWeight: '800' },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  orderId: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.text },
  names: { fontSize: 15, color: colors.text, marginTop: 4 },
  meta: { fontSize: 13, color: colors.muted, marginTop: 2 },
  selectAll: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6, paddingHorizontal: 12 },
  selectAllText: { fontSize: 16, fontWeight: '600', color: colors.text },
  empty: { textAlign: 'center', color: colors.muted, fontSize: 16, marginTop: 16 },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 16,
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
});
