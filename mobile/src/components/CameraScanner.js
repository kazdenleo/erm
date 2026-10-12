import { useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '../ui/components';
import { colors } from '../ui/theme';

const BARCODE_TYPES = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'code93', 'itf14', 'codabar', 'qr', 'datamatrix'];

/** Тот же код повторно не принимаем, пока он в кадре (камера шлёт десятки событий в секунду). */
const SAME_CODE_PAUSE_MS = 2000;

export function CameraScanner({ visible, onClose, onScan, hint }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [lastCode, setLastCode] = useState('');
  const lastRef = useRef({ code: '', at: 0 });

  const handleScanned = ({ data }) => {
    const code = String(data || '').trim();
    if (!code) return;
    const now = Date.now();
    if (lastRef.current.code === code && now - lastRef.current.at < SAME_CODE_PAUSE_MS) return;
    lastRef.current = { code, at: now };
    setLastCode(code);
    onScan(code);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container}>
        {!permission ? null : !permission.granted ? (
          <View style={styles.center}>
            <Text style={styles.text}>Разрешите доступ к камере, чтобы сканировать штрихкоды.</Text>
            <Button title="Разрешить" onPress={requestPermission} />
            <Button title="Закрыть" variant="secondary" onPress={onClose} />
          </View>
        ) : (
          <>
            <CameraView
              style={styles.camera}
              facing="back"
              enableTorch={torch}
              barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
              onBarcodeScanned={visible ? handleScanned : undefined}
            />
            <View pointerEvents="none" style={styles.frame} />
            <View style={styles.bottom}>
              {hint ? <Text style={styles.hint}>{hint}</Text> : null}
              <Text style={styles.last} numberOfLines={1}>
                {lastCode ? `Последний: ${lastCode}` : 'Наведите камеру на штрихкод'}
              </Text>
              <View style={styles.row}>
                <Pressable style={styles.action} onPress={() => setTorch((t) => !t)}>
                  <Text style={styles.actionText}>{torch ? 'Фонарик: вкл' : 'Фонарик'}</Text>
                </Pressable>
                <Pressable style={[styles.action, styles.close]} onPress={onClose}>
                  <Text style={[styles.actionText, styles.closeText]}>Готово</Text>
                </Pressable>
              </View>
            </View>
          </>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  frame: {
    position: 'absolute',
    left: '10%',
    right: '10%',
    top: '30%',
    height: '22%',
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.85)',
    borderRadius: 16,
  },
  bottom: { padding: 16, gap: 10, backgroundColor: '#000' },
  hint: { color: '#FDE68A', fontSize: 16, fontWeight: '600', textAlign: 'center' },
  last: { color: '#fff', fontSize: 15, textAlign: 'center' },
  row: { flexDirection: 'row', gap: 12 },
  action: {
    flex: 1,
    minHeight: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1F2937',
  },
  actionText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  close: { backgroundColor: colors.primary },
  closeText: { color: colors.primaryText },
  center: { flex: 1, padding: 24, gap: 14, justifyContent: 'center', backgroundColor: colors.bg },
  text: { fontSize: 17, color: colors.text, textAlign: 'center' },
});
