import { QUADRANT_META, type Task } from '@grid/core';
import { useMemo, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  LayoutAnimation,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  UIManager,
  View,
} from 'react-native';

// Android 的布局动画默认关闭
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useApp } from '../../src/store';
import { C, FONT, HIT, SP } from '../../src/theme';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

function todayLabel(): string {
  const d = new Date();
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${WEEK[d.getDay()]}`;
}

export default function TodayScreen() {
  const { snapshot, phase, pending, refresh, toggleTask, createTask } = useApp();
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const todayKey = useMemo(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }, []);

  /**
   * 今日页只放"今天要做的事"，分三段：
   *   逾期   —— 截止日早于今天、还没做完的
   *   今天   —— 截止日就是今天，或者今天有具体时间的
   *   收件箱 —— 完全没有日期/时间的（还没排期的）
   *
   * 未来日期的任务**不出现**：它们属于"以后"，塞进今日只会让这一页
   * 变成"全部任务"的别名 —— 这正是之前的问题。
   */
  const sections = useMemo(() => {
    const keyOf = (ts: number) => {
      const d = new Date(ts);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    // 先按象限（1 最重要），再按手动排序
    const byQuadrant = (a: Task, b: Task) => a.quadrant - b.quadrant || a.sortOrder - b.sortOrder;

    const overdue: Task[] = [];
    const dueToday: Task[] = [];
    const inbox: Task[] = [];

    for (const task of snapshot.tasks) {
      if (task.completedAt !== null) continue;
      const hasTime = task.startAt !== null;
      const startIsToday = hasTime && keyOf(task.startAt!) === todayKey;
      const due = task.dueDate;

      if (due !== null && due < todayKey) {
        overdue.push(task);
        continue;
      }
      if (due === todayKey || startIsToday) {
        dueToday.push(task);
        continue;
      }
      // 既没日期也没时间 → 收件箱；有未来日期的直接跳过
      if (due === null && !hasTime) inbox.push(task);
    }

    return {
      overdue: overdue.sort(byQuadrant),
      dueToday: dueToday.sort((a, b) => (a.startAt ?? 0) - (b.startAt ?? 0) || byQuadrant(a, b)),
      inbox: inbox.sort(byQuadrant),
    };
  }, [snapshot.tasks, todayKey]);

  type Item =
    | { kind: 'header'; key: string; title: string; count: number }
    | { kind: 'task'; task: Task };

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const push = (key: string, title: string, list: Task[]) => {
      if (list.length === 0) return;
      out.push({ kind: 'header', key: `h-${key}`, title, count: list.length });
      for (const task of list) out.push({ kind: 'task', task });
    };
    push('overdue', '已逾期', sections.overdue);
    push('today', '今日', sections.dueToday);
    push('inbox', '收件箱', sections.inbox);
    return out;
  }, [sections]);

  const openCount = sections.overdue.length + sections.dueToday.length;

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
    // 只传标题：象限、日期、重复都留到详情页再补。
    // 新建就逼人做四个分类决策，是"收集"这一步最容易断掉的地方。
    await createTask({ title: value });
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <View style={styles.head}>
          <View style={styles.headLeft}>
            <Text style={styles.date}>{todayLabel()}</Text>
            <Text style={styles.count}>
              {openCount} 项今天要做
              {doneToday > 0 ? ` · 今日已完成 ${doneToday}` : ''}
            </Text>
          </View>
          {/* 设置收进角落：底部 tab 是高频动作，账号/地址这类低频项不该占一格 */}
          <Pressable
            onPress={() => router.push('/settings')}
            style={styles.settingsBtn}
            accessibilityRole="button"
            accessibilityLabel="设置"
          >
            <Ionicons name="settings-outline" size={22} color={C.n600} />
          </Pressable>
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
          data={items}
          keyExtractor={(item) => (item.kind === 'header' ? item.key : item.task.id)}
          contentContainerStyle={items.length === 0 ? styles.listEmpty : styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={C.a500} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>今天没有要做的</Text>
              <Text style={styles.emptyHint}>在下面输入框写点什么，回车即存；带未来日期的任务在「列表」里</Text>
            </View>
          }
          renderItem={({ item }) =>
            item.kind === 'header' ? (
              <View style={styles.groupHead}>
                <Text style={styles.groupTitle}>{item.title}</Text>
                <Text style={styles.groupCount}>{item.count}</Text>
              </View>
            ) : (
              <Row
                task={item.task}
                onToggle={() => {
                  try {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  } catch {
                    /* 动画失败不影响功能 */
                  }
                  toggleTask(item.task.id).catch((err: unknown) => {
                    console.warn('[toggle]', err);
                  });
                }}
              />
            )
          }
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
          {/* 这里不再放加号：右下角已有全局 FAB，两个加号会让人不知道点哪个。
              输入框回车即存，本身就是提交入口 */}

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
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: SP[4],
    paddingTop: SP[4],
    paddingBottom: SP[3],
  },
  headLeft: { flex: 1 },
  settingsBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -4,
  },
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
  groupHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: SP[2],
    paddingTop: SP[3],
    paddingBottom: SP[1],
    borderBottomWidth: 1,
    borderBottomColor: C.n200,
  },
  groupTitle: { fontSize: FONT.xs, color: C.n500, letterSpacing: 1 },
  groupCount: { fontSize: FONT.xs, color: C.n400 },
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
