import { QUADRANT_META, type Task } from '@grid/core';
import { useMemo, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../../src/store';
import { C, FONT, HIT, SP } from '../../src/theme';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

function todayLabel(): string {
  const d = new Date();
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${WEEK[d.getDay()]}`;
}

export default function TodayScreen() {
  const { snapshot, phase, pending, refresh, toggleTask, createTask } = useApp();
  const [title, setTitle] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const open = useMemo(
    () =>
      snapshot.tasks
        .filter((task) => task.completedAt === null)
        // 先按象限（1 最重要），再按手动排序。sortOrder 允许负数，
        // 新建任务用 -Date.now() 塞到最前，所以直接升序就够
        .sort((a, b) => a.quadrant - b.quadrant || a.sortOrder - b.sortOrder),
    [snapshot.tasks],
  );

  const doneToday = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return snapshot.tasks.filter((t) => t.completedAt !== null && t.completedAt >= start.getTime()).length;
  }, [snapshot.tasks]);

  async function onRefresh() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  async function submit() {
    const value = title.trim();
    if (!value) return;
    setTitle('');
    await createTask(value);
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <View style={styles.head}>
          <Text style={styles.date}>{todayLabel()}</Text>
          <Text style={styles.count}>
            {open.length} 项待办
            {doneToday > 0 ? ` · 今日已完成 ${doneToday}` : ''}
          </Text>
        </View>

        {phase === 'offline' ? (
          <View style={styles.bannerOffline}>
            <Text style={styles.bannerOfflineText}>
              离线 · 改动已存在本机{pending > 0 ? `，${pending} 条待同步` : ''}
            </Text>
          </View>
        ) : pending > 0 ? (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{pending} 条改动待同步</Text>
          </View>
        ) : null}

        <FlatList
          data={open}
          keyExtractor={(item) => item.id}
          contentContainerStyle={open.length === 0 ? styles.listEmpty : styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={C.a500} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>没有待办</Text>
              <Text style={styles.emptyHint}>在下面输入框写点什么，回车即存</Text>
            </View>
          }
          renderItem={({ item }) => <Row task={item} onToggle={() => void toggleTask(item.id)} />}
        />

        <View style={styles.composer}>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="新建待办…"
            placeholderTextColor={C.n400}
            style={styles.composerInput}
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
            blurOnSubmit={false}
          />
          <Pressable
            onPress={() => void submit()}
            style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.7 }]}
            accessibilityRole="button"
            accessibilityLabel="添加待办"
          >
            <Text style={styles.addBtnText}>＋</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Row({ task, onToggle }: { task: Task; onToggle: () => void }) {
  const meta = QUADRANT_META[task.quadrant];
  return (
    <View style={styles.row}>
      <Pressable
        onPress={onToggle}
        hitSlop={8}
        style={styles.check}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: false }}
        accessibilityLabel={`完成「${task.title}」`}
      >
        <View style={styles.checkBox} />
      </Pressable>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {task.title}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {meta?.title ?? ''}
          {task.dueDate ? ` · ${task.dueDate}` : ''}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.n0 },
  flex: { flex: 1 },
  head: { paddingHorizontal: SP[4], paddingTop: SP[4], paddingBottom: SP[3] },
  date: { fontSize: FONT.xl, color: C.n900, fontWeight: '600' },
  count: { marginTop: SP[1], fontSize: FONT.base, color: C.n500 },
  banner: {
    marginHorizontal: SP[4],
    marginBottom: SP[2],
    paddingVertical: SP[2],
    paddingHorizontal: SP[3],
    backgroundColor: C.n50,
    borderLeftWidth: 2,
    borderLeftColor: C.a500,
  },
  bannerText: { fontSize: FONT.sm, color: C.n600 },
  bannerOffline: {
    marginHorizontal: SP[4],
    marginBottom: SP[2],
    paddingVertical: SP[2],
    paddingHorizontal: SP[3],
    backgroundColor: '#fdf6e3',
    borderLeftWidth: 2,
    borderLeftColor: C.warn,
  },
  bannerOfflineText: { fontSize: FONT.sm, color: C.warn },
  list: { paddingHorizontal: SP[4], paddingBottom: SP[8] },
  listEmpty: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: SP[4] },
  empty: { alignItems: 'flex-start' },
  emptyTitle: { fontSize: FONT.md, color: C.n700 },
  emptyHint: { marginTop: SP[1], fontSize: FONT.base, color: C.n500 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: HIT + 8,
    borderBottomWidth: 1,
    borderBottomColor: C.n200,
  },
  check: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  checkBox: {
    width: 18,
    height: 18,
    borderWidth: 1.5,
    borderColor: C.n500,
    borderRadius: 2,
    backgroundColor: C.n0,
  },
  rowBody: { flex: 1, paddingVertical: SP[2], paddingRight: SP[2] },
  rowTitle: { fontSize: FONT.body, color: C.n900, lineHeight: 21 },
  rowMeta: { marginTop: 2, fontSize: FONT.xs, color: C.n500 },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP[2],
    paddingHorizontal: SP[4],
    paddingVertical: SP[3],
    borderTopWidth: 1,
    borderTopColor: C.n200,
    backgroundColor: C.n0,
  },
  composerInput: {
    flex: 1,
    minHeight: HIT,
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
    paddingHorizontal: SP[3],
    fontSize: FONT.body,
    color: C.n900,
  },
  addBtn: {
    width: HIT,
    height: HIT,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.a500,
    borderRadius: 2,
  },
  addBtnText: { color: C.n0, fontSize: 22, lineHeight: 26 },
});
