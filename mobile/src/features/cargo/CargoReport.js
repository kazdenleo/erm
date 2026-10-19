import { StyleSheet, Text, View } from 'react-native';
import { ProductMeta } from '../../components/ProductMeta';
import { colors } from '../../ui/theme';

/** Отчёт: сколько товара в каком грузоместе. */
export function CargoReport({ report, title = 'Товар по грузоместам', addressStorageEnabled }) {
  const places = report?.places || [];
  const storageOn = addressStorageEnabled ?? report?.addressStorageEnabled === true;
  if (!places.length) {
    return (
      <View style={styles.wrap}>
        <Text style={styles.section}>{title}</Text>
        <Text style={styles.muted}>Пока нет принятого товара</Text>
      </View>
    );
  }
  return (
    <View style={styles.wrap}>
      <Text style={styles.section}>
        {title}
        {report?.totalQuantity != null ? ` · ${report.totalQuantity} шт` : ''}
      </Text>
      {places.map((place) => (
        <View key={place.placeId} style={styles.place}>
          <Text style={styles.barcode}>{place.barcode}</Text>
          <Text style={styles.muted}>{place.quantity} шт</Text>
          {(place.items || []).map((item) => (
            <View key={`${place.placeId}-${item.productId}`} style={styles.item}>
              <View style={styles.flex}>
                <Text style={styles.name}>{item.name}</Text>
                <ProductMeta
                  article={item.article || item.sku}
                  locationCode={item.locationCode}
                  addressStorageEnabled={storageOn}
                />
              </View>
              <Text style={styles.qty}>{item.quantity}</Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  section: { fontSize: 18, fontWeight: '700', color: colors.text },
  muted: { fontSize: 14, color: colors.muted },
  place: {
    gap: 6,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  barcode: { fontSize: 16, fontWeight: '700', color: colors.text },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  flex: { flex: 1 },
  name: { fontSize: 15, color: colors.text },
  qty: { fontSize: 18, fontWeight: '800', color: colors.text, minWidth: 36, textAlign: 'right' },
});
