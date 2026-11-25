import * as Linking from 'expo-linking';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PermissionGuide } from '../src/notify/PermissionGuide';
import { currentPermission, type NotificationPermission } from '../src/notify/schedule';
import { useApp } from '../src/store';
import { C, FONT, HIT, SP } from '../src/theme';

const PHASE_LABEL: Record<string, string> = {
  idle: '已同步',
  syncing: '同步中…',
  offline: '离线',
  error: '同步失败',
};

function when(ts: number | null): string {
  if (!ts) return '还没同步过';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 本地日期。不走 toLocaleDateString：Hermes 的 Intl 覆盖不全，部分设备会返回英文格式 */
function shortDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function SettingsScreen() {
  const { auth, phase, pending, lastSyncAt, lastError, apiBase, refresh, signOut, changeApiBase, forceResync, snapshot } = useApp();
  const [draft, setDraft] = useState(apiBase);
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>('undetermined');
  const [guideVisible, setGuideVisible] = useState(false);

  // 每次进出设置页都重新读一次：用户可能刚在系统设置里改过
  useEffect(() => {
    void currentPermission().then(setPermission);
  }, [guideVisible]);

  async function saveBase() {
    if (draft.trim() === apiBase) return;
    setBusy(true);
    try {
      await changeApiBase(draft);
      Alert.alert('已切换', '本地缓存已清空并重新拉取。');
    } catch (err) {
      Alert.alert('地址无效', err instanceof Error ? err.message : '请检查格式');
      setDraft(apiBase);
    } finally {
      setBusy(false);
    }
  }

  function confirmSignOut() {
    Alert.alert('退出登录', '本机缓存会被清空，下次需要重新登录。', [
      { text: '取消', style: 'cancel' },
      { text: '退出', style: 'destructive', onPress: () => void signOut() },
    ]);
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>设置</Text>

        <Section label="账号">
          <Text style={styles.value}>{auth?.email ?? '未登录'}</Text>
          {auth ? (
            <Text style={styles.hint}>
              设备令牌到期：{shortDate(auth.expiresAt)}
              （临期会自动续，不需要你操作）
            </Text>
          ) : null}
        </Section>

        <Section label="同步">
          <View style={styles.syncRow}>
            <Text style={styles.value}>{PHASE_LABEL[phase] ?? phase}</Text>
            {pending > 0 ? <Text style={styles.pending}>{pending} 条待推</Text> : null}
          </View>
          <Text style={styles.hint}>
            上次同步：{when(lastSyncAt)} · 本地 {snapshot.tasks.filter((t) => t.deletedAt === null).length} 条待办 /{' '}
            {snapshot.logs.length} 条打卡 / {snapshot.events.length} 个日程
          </Text>
          {snapshot.events.length === 0 ? (
            <Text style={styles.hint}>
              还没有日程数据。Outlook 是在网页版里连接的（设置 → 日历），手机端只负责同步下来。
              先在网页版确认能看到日历，再回来点「立即同步」。
            </Text>
          ) : null}
          {lastError ? <Text style={styles.error}>{lastError}</Text> : null}
          <Pressable
            onPress={() => void refresh()}
            disabled={phase === 'syncing'}
            style={({ pressed }) => [styles.btn, pressed && { opacity: 0.7 }]}
            accessibilityRole="button"
          >
            <Text style={styles.btnText}>{phase === 'syncing' ? '同步中…' : '立即同步'}</Text>
          </Pressable>

          <Pressable
            onPress={() => {
              Alert.alert(
                '重新拉取全部数据',
                '清空本机缓存并从服务器完整下载一遍。\n\n什么时候用：两端数字对不上、而且怎么同步都不变的时候。\n\n会先把未推送的改动推上去，推不出去会中止，不会丢数据。',
                [
                  { text: '取消', style: 'cancel' },
                  {
                    text: '开始',
                    style: 'destructive',
                    onPress: () => {
                      void forceResync()
                        .then(() => Alert.alert('完成', '已重新拉取。'))
                        .catch((err: unknown) =>
                          Alert.alert('没成功', err instanceof Error ? err.message : '请检查网络后重试'),
                        );
                    },
                  },
                ],
              );
            }}
            disabled={phase === 'syncing'}
            style={({ pressed }) => [styles.btn, { marginTop: SP[2] }, pressed && { opacity: 0.7 }]}
            accessibilityRole="button"
          >
            <Text style={styles.btnText}>重新拉取全部数据</Text>
          </Pressable>
          <Text style={styles.hint}>
            只在「两端数字对不上且一直不同步」时用。平时不需要 —— 它会把本机缓存清空重下一遍。
          </Text>
        </Section>

        <Section label="服务器地址">
          <TextInput
            value={draft}
            onChangeText={setDraft}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={styles.input}
            placeholder="https://todo.stellamp.me"
            placeholderTextColor={C.n400}
            editable={!busy}
          />
          <Text style={styles.hint}>
            只填到主机名，不带 /api。改地址会清空本地缓存（数据仍在服务端，会重新拉回来）。
          </Text>
          <Pressable
            onPress={() => void saveBase()}
            disabled={busy}
            style={({ pressed }) => [styles.btn, pressed && { opacity: 0.7 }]}
            accessibilityRole="button"
          >
            <Text style={styles.btnText}>保存地址</Text>
          </Pressable>
        </Section>

        <Section label="提醒">
          <Text style={styles.value}>
            {permission === 'granted' ? '通知权限已开启' : permission === 'denied' ? '通知权限被拒绝' : '还没有请求通知权限'}
          </Text>
          <Text style={styles.hint}>
            提醒是纯本地闹钟，不经过服务器。设了提醒却不会响，九成是这里的三项没配齐 —
            尤其是「精确闹钟」和「电池白名单」，国产系统默认都会把后台闹钟掐掉。
          </Text>
          <Pressable
            onPress={() => setGuideVisible(true)}
            style={({ pressed }) => [styles.btn, pressed && { opacity: 0.7 }]}
            accessibilityRole="button"
          >
            <Text style={styles.btnText}>检查提醒权限</Text>
          </Pressable>
        </Section>

        <Section label="数据备份">
          <Text style={styles.value}>
            本机 {snapshot.tasks.filter((t) => t.deletedAt === null).length} 条待办 · {snapshot.logs.length} 条打卡 ·{' '}
            {snapshot.events.length} 个日程
          </Text>
          <Text style={styles.hint}>
            服务器每 6 小时自动备份一次，本机留 14 天。那份备份是给「服务跑坏了」用的；
            想防「服务器整个没了」，还需要你自己存一份导出文件。
          </Text>
          <Text style={styles.hint}>
            导出要在网页版做——手机上的文件存不住，一不小心就被清理掉了。
            点下面的按钮会打开浏览器，登录后到「设置 → 备份与导出」下载 JSON。
          </Text>
          <Pressable
            onPress={() => void Linking.openURL(`${apiBase}/#settings`).catch(() => {
              Alert.alert('打不开浏览器', `请手动在浏览器里访问 ${apiBase}/#settings`);
            })}
            style={({ pressed }) => [styles.btn, pressed && { opacity: 0.7 }]}
            accessibilityRole="button"
          >
            <Text style={styles.btnText}>在浏览器里导出</Text>
          </Pressable>
        </Section>

        <Section label="危险操作">
          <Pressable
            onPress={confirmSignOut}
            style={({ pressed }) => [styles.btnDanger, pressed && { opacity: 0.7 }]}
            accessibilityRole="button"
          >
            <Text style={styles.btnDangerText}>退出登录</Text>
          </Pressable>
        </Section>

        <Text style={styles.footer}>GRID · 自托管待办与日历</Text>
      </ScrollView>

      <PermissionGuide visible={guideVisible} onClose={() => setGuideVisible(false)} />
    </SafeAreaView>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.n0 },
  scroll: { paddingHorizontal: SP[4], paddingTop: SP[4], paddingBottom: SP[12] },
  title: { fontSize: FONT.xl, color: C.n900, fontWeight: '600', marginBottom: SP[6] },
  section: { marginBottom: SP[6], borderTopWidth: 1, borderTopColor: C.n200, paddingTop: SP[3] },
  sectionLabel: { fontSize: FONT.xs, color: C.n500, letterSpacing: 1, marginBottom: SP[2] },
  value: { fontSize: FONT.md, color: C.n900 },
  hint: { marginTop: SP[2], fontSize: FONT.sm, color: C.n500, lineHeight: 18 },
  error: { marginTop: SP[2], fontSize: FONT.sm, color: C.danger },
  syncRow: { flexDirection: 'row', alignItems: 'baseline', gap: SP[3] },
  pending: { fontSize: FONT.sm, color: C.warn },
  input: {
    minHeight: HIT,
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
    paddingHorizontal: SP[3],
    fontSize: FONT.body,
    color: C.n900,
  },
  btn: {
    marginTop: SP[3],
    minHeight: HIT,
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: { fontSize: FONT.body, color: C.n900 },
  btnDanger: {
    minHeight: HIT,
    borderWidth: 1,
    borderColor: C.danger,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDangerText: { fontSize: FONT.body, color: C.danger },
  footer: { marginTop: SP[8], fontSize: FONT.xs, color: C.n400, textAlign: 'center' },
});
