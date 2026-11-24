import { habitLogId, habitUnit, isScheduled, weekdayOfKey, type Habit } from '@grid/core';
import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../../src/store';
import { C, FONT, HIT, SP } from '../../src/theme';

function todayKey(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function HabitsScreen() {
  const { snapshot, checkHabit, phase, createHabit } = useApp();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftType, setDraftType] = useState<'check' | 'count' | 'duration'>('check');
  const [draftTarget, setDraftTarget] = useState('1');
  const [draftUnit, setDraftUnit] = useState('');
  const [draftDays, setDraftDays] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);

  async function submitHabit() {
    if (draftName.trim() === '' || saving) return;
    setSaving(true);
    try {
      await createHabit({
        name: draftName,
        type: draftType,
        target: draftType === 'check' ? 1 : Number(draftTarget) || 1,
        unit: draftType === 'check' ? null : draftUnit.trim() || (draftType === 'duration' ? '分钟' : '次'),
        daysOfWeek: draftDays,
      });
      setDraftName('');
      setDraftType('check');
      setDraftTarget('1');
      setDraftUnit('');
      setDraftDays([]);
      setCreating(false);
    } finally {
      setSaving(false);
    }
  }
  const [dayKey] = useState(todayKey);

  const due = useMemo(() => {
    const weekday = weekdayOfKey(dayKey);
    return snapshot.habits
      .filter((habit) => habit.archivedAt === null && isScheduled(dayKey, habit.daysOfWeek))
      // 只保留今天该做的（daysOfWeek 里包含今天）
      .filter(() => weekday >= 0)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [snapshot.habits, dayKey]);

  const valueOf = (habitId: string): number => {
    const log = snapshot.logs.find((l) => l.habitId === habitId && l.logDate === dayKey);
    return log?.value ?? 0;
  };

  const doneCount = due.filter((habit) => valueOf(habit.id) >= habit.target).length;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.head}>
        <Text style={styles.title}>今日打卡</Text>
        <Text style={styles.sub}>
          {due.length === 0 ? '今天没有安排的习惯' : `${doneCount} / ${due.length} 已完成`}
          {phase === 'offline' ? ' · 离线（记录已存本机）' : ''}
        </Text>
      </View>

      <FlatList
        data={due}
        keyExtractor={(h) => h.id}
        contentContainerStyle={due.length === 0 ? styles.emptyWrap : styles.list}
        ListEmptyComponent={
          <View>
            <Text style={styles.emptyTitle}>没有要做的习惯</Text>
            <Text style={styles.emptyHint}>
              习惯在设置里创建后才会出现在这里。手机上暂不支持新建，先在 Web 端建好同步过来。
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <HabitRow
            habit={item}
            value={valueOf(item.id)}
            onPress={() => {
              const value = valueOf(item.id);
              // 已达标再点一次是"撤销"：打卡最常见的误操作是按多了，
              // 没有退路的话只能去 Web 端改
              const delta = value >= item.target ? -value : stepOf(item);
              void checkHabit(item.id, dayKey, delta);
            }}
            onReset={() => {
              // 长按清零。计数型点到 3/8 想全部撤销时，靠"先点够 8 次再点一下"是荒谬的，
              // 而只给"已达标可撤销"就永远清不掉中间态
              void checkHabit(item.id, dayKey, -valueOf(item.id));
            }}
            onOpen={() => router.push(`/habit/${item.id}`)}
          />
        )}
      />

      <Modal visible={creating} transparent animationType="slide" onRequestClose={() => setCreating(false)}>
        <Pressable style={styles.backdrop} onPress={() => setCreating(false)} accessibilityLabel="关闭" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.sheetTitle}>新建习惯</Text>

          <TextInput
            value={draftName}
            onChangeText={setDraftName}
            placeholder="比如：喝 8 杯水"
            placeholderTextColor={C.n400}
            style={styles.input}
            autoFocus
          />

          <View style={styles.segments}>
            {([
              ['check', '打勾'],
              ['count', '计数'],
              ['duration', '时长'],
            ] as const).map(([key, label]) => (
              <Pressable
                key={key}
                onPress={() => setDraftType(key)}
                style={[styles.segment, draftType === key && styles.segmentOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: draftType === key }}
              >
                <Text style={[styles.segmentText, draftType === key && styles.onText]}>{label}</Text>
              </Pressable>
            ))}
          </View>

          {draftType !== 'check' ? (
            <View style={styles.inlineRow}>
              <TextInput
                value={draftTarget}
                onChangeText={setDraftTarget}
                keyboardType="number-pad"
                placeholder="目标"
                placeholderTextColor={C.n400}
                style={[styles.input, styles.flex]}
              />
              <TextInput
                value={draftUnit}
                onChangeText={setDraftUnit}
                placeholder={draftType === 'duration' ? '分钟' : '杯 / 次'}
                placeholderTextColor={C.n400}
                style={[styles.input, styles.flex]}
              />
            </View>
          ) : null}

          <Text style={styles.fieldLabel}>每周重复（不选 = 每天）</Text>
          <View style={styles.daysRow}>
            {['一', '二', '三', '四', '五', '六', '日'].map((label, index) => {
              const on = draftDays.includes(index);
              return (
                <Pressable
                  key={label}
                  onPress={() =>
                    setDraftDays((prev) => (on ? prev.filter((x) => x !== index) : [...prev, index].sort((a, b) => a - b)))
                  }
                  style={[styles.dayChip, on && styles.segmentOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                >
                  <Text style={[styles.segmentText, on && styles.onText]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.actions}>
            <Pressable onPress={() => setCreating(false)} style={styles.ghost} accessibilityRole="button">
              <Text style={styles.ghostText}>取消</Text>
            </Pressable>
            <Pressable
              onPress={() => void submitHabit()}
              disabled={draftName.trim() === '' || saving}
              style={[styles.primary, (draftName.trim() === '' || saving) && styles.primaryDisabled]}
              accessibilityRole="button"
            >
              <Text style={styles.primaryText}>创建</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function stepOf(habit: Habit): number {
  if (habit.type === 'check') return 1;
  if (habit.type === 'duration') return Math.min(5, habit.target);
  return 1;
}

function HabitRow({ habit, value, onPress, onReset, onOpen }: { habit: Habit; value: number; onPress: () => void; onReset: () => void; onOpen: () => void }) {
  const reached = value >= habit.target;
  const unit = habitUnit(habit);
  const pct = habit.target > 0 ? Math.min(1, value / habit.target) : value > 0 ? 1 : 0;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onReset}
      delayLongPress={350}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: C.n50 }]}
      accessibilityRole="button"
      accessibilityLabel={
        reached
          ? `${habit.name} 已完成，点击撤销，长按清零`
          : `${habit.name} 进度 ${value} / ${habit.target} ${unit}，点击记录，长按清零`
      }
    >
      <View style={[styles.mark, reached && styles.markDone]}>
        {reached ? <Text style={styles.markText}>✓</Text> : null}
      </View>

      <Pressable style={styles.rowBody} onPress={onOpen} accessibilityRole="button" accessibilityLabel={`打开「${habit.name}」的详情`}>
        <Text style={[styles.name, reached && styles.nameDone]} numberOfLines={1}>
          {habit.name}
        </Text>
        <View style={styles.bar}>
          <View style={[styles.barFill, { width: `${Math.round(pct * 100)}%` }, reached && styles.barFillDone]} />
        </View>
      </Pressable>

      <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel="查看统计">
      <Text style={styles.progress}>
        {value}
        <Text style={styles.progressTarget}>/{habit.target}</Text>
        <Text style={styles.unit}> {unit}</Text>
      </Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headLeft: { flex: 1 },
  addBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -4,
  },
  addText: { fontSize: 26, color: C.a500, lineHeight: 30 },
  backdrop: { flex: 1, backgroundColor: 'rgba(10,10,10,0.28)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: C.n0,
    borderTopWidth: 1,
    borderTopColor: C.n200,
    paddingHorizontal: SP[4],
    paddingTop: SP[2],
    paddingBottom: SP[8],
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 3,
    backgroundColor: C.n200,
    borderRadius: 2,
    marginBottom: SP[3],
  },
  sheetTitle: { fontSize: FONT.md, color: C.n900, fontWeight: '600', marginBottom: SP[2] },
  input: {
    height: HIT,
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
    paddingHorizontal: SP[3],
    fontSize: FONT.body,
    color: C.n900,
    marginTop: SP[2],
  },
  flex: { flex: 1 },
  inlineRow: { flexDirection: 'row', gap: SP[2] },
  segments: { flexDirection: 'row', gap: 1, backgroundColor: C.n200, borderWidth: 1, borderColor: C.n200, marginTop: SP[2] },
  segment: { flex: 1, height: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: C.n0 },
  segmentOn: { backgroundColor: C.a500 },
  segmentText: { fontSize: FONT.sm, color: C.n600 },
  onText: { color: C.n0 },
  fieldLabel: { marginTop: SP[3], fontSize: FONT.xs, color: C.n500 },
  daysRow: { flexDirection: 'row', gap: SP[1], marginTop: SP[1] },
  dayChip: {
    flex: 1,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: SP[2], marginTop: SP[4] },
  ghost: { height: HIT, paddingHorizontal: SP[4], borderWidth: 1, borderColor: C.n300, borderRadius: 2, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontSize: FONT.body, color: C.n700 },
  primary: { height: HIT, paddingHorizontal: SP[6], borderRadius: 2, backgroundColor: C.a500, alignItems: 'center', justifyContent: 'center' },
  primaryDisabled: { backgroundColor: C.n300 },
  primaryText: { fontSize: FONT.body, color: C.n0 },
  root: { flex: 1, backgroundColor: C.n0 },
  head: { paddingHorizontal: SP[4], paddingTop: SP[4], paddingBottom: SP[3] },
  title: { fontSize: FONT.xl, color: C.n900, fontWeight: '600' },
  sub: { marginTop: SP[1], fontSize: FONT.base, color: C.n500 },
  list: { paddingHorizontal: SP[4], paddingBottom: SP[8] },
  emptyWrap: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: SP[4] },
  emptyTitle: { fontSize: FONT.md, color: C.n700 },
  emptyHint: { marginTop: SP[2], fontSize: FONT.base, color: C.n500, lineHeight: 21 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP[3],
    minHeight: HIT + 20,
    borderBottomWidth: 1,
    borderBottomColor: C.n200,
    paddingVertical: SP[2],
  },
  mark: {
    width: 26,
    height: 26,
    borderWidth: 1.5,
    borderColor: C.n400,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markDone: { backgroundColor: C.a500, borderColor: C.a500 },
  markText: { color: C.n0, fontSize: 15, lineHeight: 18 },
  rowBody: { flex: 1 },
  name: { fontSize: FONT.body, color: C.n900 },
  nameDone: { color: C.n500 },
  bar: { marginTop: SP[2], height: 3, backgroundColor: C.n100, borderRadius: 2 },
  barFill: { height: 3, backgroundColor: C.a200, borderRadius: 2 },
  barFillDone: { backgroundColor: C.a500 },
  progress: { fontSize: FONT.body, color: C.n900, fontVariant: ['tabular-nums'] },
  progressTarget: { color: C.n500 },
  unit: { fontSize: FONT.xs, color: C.n500 },
});
