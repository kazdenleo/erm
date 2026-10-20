import { useCallback, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { productsApi } from '../../api/erp';
import { errorMessage } from '../../api/client';
import { scanError, scanOk } from '../../lib/feedback';
import { printPackagingLabel } from '../../lib/labels';
import {
  boxPackagingsFromProduct,
  matchBoxPackaging,
} from '../../utils/productBoxPackagings';
import { ScanBar } from '../../components/ScanBar';
import { Banner, Button, Card, Chip } from '../../ui/components';
import { colors } from '../../ui/theme';

const COPIES = [1, 2, 3, 5];

function productTitle(p) {
  if (!p) return '';
  const name = String(p.name || '').trim();
  const sku = String(p.sku || '').trim();
  if (name && sku) return `${name} · ${sku}`;
  return name || sku || `Товар #${p.id}`;
}

export default function PackagingPrintScreen() {
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [copies, setCopies] = useState(1);
  const [lastProduct, setLastProduct] = useState(null);
  const [packagings, setPackagings] = useState([]);
  const [lastPrinted, setLastPrinted] = useState(null);

  const printPack = useCallback(async (product, pack, copiesCount) => {
    await printPackagingLabel(product.id, {
      barcode: pack.barcode,
      unitsPerBox: pack.units_per_box,
      copies: copiesCount,
    });
  }, []);

  const handleScan = useCallback(
    async (raw) => {
      const code = String(raw || '').trim();
      if (!code || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const product = await productsApi.byBarcode(code);
        if (!product?.id) {
          scanError();
          setMessage({ kind: 'error', text: 'Товар не найден' });
          setLastProduct(null);
          setPackagings([]);
          setLastPrinted(null);
          return;
        }
        const packs = boxPackagingsFromProduct(product);
        setLastProduct(product);
        setPackagings(packs);
        if (!packs.length) {
          scanError();
          setMessage({
            kind: 'error',
            text: 'У товара нет ШК упаковки — задайте его в карточке товара',
          });
          setLastPrinted(null);
          return;
        }
        const matched = matchBoxPackaging(packs, code);
        const pack = matched || packs[0];
        await printPack(product, pack, copies);
        scanOk();
        setLastPrinted(pack);
        setMessage({
          kind: 'success',
          text: matched
            ? `Напечатан ШК упаковки ${pack.barcode}`
            : packs.length > 1
              ? `Напечатан ${pack.barcode}. У товара несколько упаковок — можно выбрать другую`
              : `Напечатан ШК упаковки ${pack.barcode}`,
        });
      } catch (e) {
        scanError();
        setMessage({ kind: 'error', text: errorMessage(e, 'Ошибка поиска / печати') });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [copies, printPack]
  );

  const reprint = async (pack) => {
    if (!lastProduct || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await printPack(lastProduct, pack, copies);
      scanOk();
      setLastPrinted(pack);
      setMessage({ kind: 'success', text: `Напечатан ШК упаковки ${pack.barcode}` });
    } catch (e) {
      scanError();
      setMessage({ kind: 'error', text: errorMessage(e, 'Не удалось напечатать') });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.hint}>
        Отсканируйте товар — на принтер уйдёт этикетка с ШК упаковки. Если отсканировать сам ШК
        коробки — напечатается он. Принтер: Настройки → Принтер этикеток.
      </Text>

      <View style={styles.copiesRow}>
        <Text style={styles.copiesLabel}>Копий</Text>
        {COPIES.map((n) => (
          <Chip key={n} label={`×${n}`} active={copies === n} onPress={() => setCopies(n)} />
        ))}
      </View>

      <ScanBar
        onScan={handleScan}
        busy={busy}
        placeholder="Сканируйте товар или ШК упаковки"
        cameraHint="Наведите на штрихкод товара или коробки"
      />

      <Banner
        kind={message?.kind === 'success' ? 'success' : 'error'}
        text={message?.text}
        onClose={() => setMessage(null)}
      />

      {lastProduct ? (
        <Card style={styles.card}>
          <Text style={styles.product}>{productTitle(lastProduct)}</Text>
          {packagings.length ? (
            <View style={styles.packs}>
              {packagings.map((pack) => {
                const active = lastPrinted?.barcode === pack.barcode;
                const title =
                  pack.units_per_box > 0
                    ? `${pack.barcode} · ${pack.units_per_box} шт${active ? ' ✓' : ''}`
                    : `${pack.barcode}${active ? ' ✓' : ''}`;
                return (
                  <Button
                    key={pack.barcode}
                    title={title}
                    small
                    variant={active ? 'primary' : 'secondary'}
                    disabled={busy}
                    onPress={() => reprint(pack)}
                  />
                );
              })}
            </View>
          ) : (
            <Text style={styles.muted}>Нет ШК упаковки</Text>
          )}
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 40 },
  hint: { fontSize: 15, color: colors.muted, lineHeight: 22 },
  copiesRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  copiesLabel: { fontSize: 15, fontWeight: '600', color: colors.text, marginRight: 4 },
  card: { gap: 12 },
  product: { fontSize: 17, fontWeight: '700', color: colors.text },
  packs: { gap: 8 },
  muted: { fontSize: 14, color: colors.muted },
});
