import { ApiError } from '@grid/core';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../src/store';
import { C, FONT, HIT, SP } from '../src/theme';

export default function LoginScreen() {
  const { auth, remembered, signIn, apiBase } = useApp();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 登录过的邮箱预填：换设备/清缓存后少打十几个字符，
  // 而且能立刻看出"上次用的是哪个账号"
  useEffect(() => {
    if (remembered && !email) setEmail(remembered);
  }, [remembered, email]);

  useEffect(() => {
    if (auth) router.replace('/');
  }, [auth, router]);

  async function submit() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await signIn(email, password);
      router.replace('/');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'network_error') {
          setError(`连不上服务器。当前地址：${apiBase}\n请确认手机和电脑在同一 WiFi，或到设置里改地址。`);
        } else {
          setError(err.message);
        }
      } else {
        setError(err instanceof Error ? err.message : '登录失败');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Text style={styles.logo}>GRID</Text>
            <Text style={styles.tagline}>待办 · 日历 · 打卡</Text>
          </View>

          <View style={styles.form}>
            <Text style={styles.label}>邮箱</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              style={styles.input}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              textContentType="username"
              placeholder="you@example.com"
              placeholderTextColor={C.n400}
              editable={!busy}
            />

            <Text style={[styles.label, { marginTop: SP[4] }]}>密码</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              style={styles.input}
              secureTextEntry
              autoComplete="current-password"
              textContentType="password"
              placeholder="至少 12 位"
              placeholderTextColor={C.n400}
              editable={!busy}
              onSubmitEditing={() => void submit()}
              returnKeyType="go"
            />

            {error ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <Pressable
              onPress={() => void submit()}
              disabled={busy || !email.trim() || !password}
              style={({ pressed }) => [
                styles.button,
                (busy || !email.trim() || !password) && styles.buttonDisabled,
                pressed && styles.buttonPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="登录"
            >
              {busy ? (
                <ActivityIndicator color={C.n0} />
              ) : (
                <Text style={styles.buttonText}>登录</Text>
              )}
            </Pressable>

            <Text style={styles.hint}>
              登录后本机会拿到一个有效期 180 天的设备令牌，不必每次输密码。
            </Text>
          </View>
        </ScrollView>

        <Text style={styles.endpoint} numberOfLines={1}>
          服务器 {apiBase}
        </Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.n0 },
  flex: { flex: 1 },
  scroll: { paddingHorizontal: SP[6], paddingTop: SP[12], paddingBottom: SP[8] },
  brand: { marginBottom: SP[12] },
  logo: { fontSize: 40, letterSpacing: 2, color: C.n900, fontWeight: '600' },
  tagline: { marginTop: SP[2], fontSize: FONT.body, color: C.n500 },
  form: {},
  label: { fontSize: FONT.sm, color: C.n600, marginBottom: SP[1] },
  input: {
    minHeight: HIT,
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
    paddingHorizontal: SP[3],
    fontSize: FONT.md,
    color: C.n900,
    backgroundColor: C.n0,
  },
  errorBox: {
    marginTop: SP[4],
    borderLeftWidth: 2,
    borderLeftColor: C.danger,
    paddingLeft: SP[3],
  },
  errorText: { color: C.danger, fontSize: FONT.base, lineHeight: 20 },
  button: {
    marginTop: SP[6],
    minHeight: HIT,
    backgroundColor: C.a500,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 2,
  },
  buttonDisabled: { backgroundColor: C.n300 },
  buttonPressed: { backgroundColor: C.a500, opacity: 0.86 },
  buttonText: { color: C.n0, fontSize: FONT.md, fontWeight: '600' },
  hint: { marginTop: SP[4], fontSize: FONT.sm, color: C.n500, lineHeight: 18 },
  endpoint: {
    paddingHorizontal: SP[6],
    paddingBottom: SP[4],
    fontSize: FONT.xs,
    color: C.n400,
  },
});
