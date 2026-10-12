import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { errorMessage } from '../api/client';
import { Banner, Button, Card, Field, Loading } from '../ui/components';
import { colors } from '../ui/theme';

export default function LoginScreen() {
  const { status, serverUrl } = useAuth();
  if (status === 'loading') return <Loading text="Подключение к серверу…" />;
  return <LoginForm initialServer={serverUrl} />;
}

function LoginForm({ initialServer }) {
  const { status, bootError, retry, signIn } = useAuth();
  const [server, setServer] = useState(initialServer);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    if (!server.trim() || !login.trim() || !password) {
      setError('Заполните адрес сервера, логин и пароль');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn({ server, login, password });
    } catch (e) {
      setError(errorMessage(e, 'Не удалось войти'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Text style={styles.title}>ERM Склад</Text>
            <Text style={styles.subtitle}>Сборка заказов и приёмка товара</Text>
          </View>

          {status === 'error' && bootError ? (
            <Card style={styles.gap}>
              <Banner kind="warning" text={`Сервер недоступен: ${bootError}`} />
              <Button title="Повторить подключение" variant="secondary" onPress={retry} />
            </Card>
          ) : null}

          <Card style={styles.gap}>
            <Field
              label="Адрес сервера"
              value={server}
              onChangeText={setServer}
              placeholder="192.168.1.10:3001 или https://erp.example.ru"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <Field
              label="Email или телефон"
              value={login}
              onChangeText={setLogin}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="username"
            />
            <Field
              label="Пароль"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              textContentType="password"
              onSubmitEditing={submit}
              returnKeyType="go"
            />
            <Banner text={error} onClose={() => setError(null)} />
            <Button title="Войти" onPress={submit} loading={busy} />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  content: { padding: 20, gap: 16, flexGrow: 1, justifyContent: 'center' },
  header: { alignItems: 'center', marginBottom: 8, gap: 4 },
  title: { fontSize: 30, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 16, color: colors.muted },
  gap: { gap: 14 },
});
