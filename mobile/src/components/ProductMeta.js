import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../ui/theme';

/**
 * Артикул и ячейка под названием товара.
 * Ячейка — только при включённом адресном хранении.
 */
export function ProductMeta({
  article,
  sku,
  locationCode,
  addressStorageEnabled = false,
  compact = false,
}) {
  const art = String(article || sku || '').trim();
  const cell = String(locationCode || '').trim();
  const showCell = addressStorageEnabled === true;
  if (!art && !showCell) return null;
  return (
    <View style={compact ? styles.wrapCompact : styles.wrap}>
      {art ? <Text style={compact ? styles.metaCompact : styles.meta}>Арт. {art}</Text> : null}
      {showCell ? (
        <Text style={[compact ? styles.metaCompact : styles.meta, cell ? styles.cell : styles.cellEmpty]}>
          {cell ? `Ячейка ${cell}` : 'Нет ячейки'}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 2, gap: 1 },
  wrapCompact: { marginTop: 1, gap: 0 },
  meta: { fontSize: 13, color: colors.muted },
  metaCompact: { fontSize: 12, color: colors.muted },
  cell: { color: colors.text, fontWeight: '600' },
  cellEmpty: { color: colors.warning },
});
