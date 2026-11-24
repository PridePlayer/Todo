import {
  computeStreak,
  dateKeyInZone,
  formatRate,
  habitUnit,
  heatmapWeeks,
  rateBuckets,
  reached,
} from '@grid/core';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../../src/store';
import { C, FONT, HIT, SP } from '../../src/theme';

function todayKey(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 五档灰阶/蓝色，与 Web 端 Heatmap 一致：按占目标比例上色，不按绝对值 */
const LEVEL_COLOR = [C.n100, C.a100, C.a200, C.a500, C.a700];

const TYPE_LABEL: Record<string, string> = { check: '打勾', count: '计数', duration: '时长' };

export default function HabitDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { snapshot, patchHabit, archiveHabit, deleteHabit } = useApp();
  const habit = snapshot.habits.find((h) => h.id === id);
  const [targetDraft, setTargetDraft] = useState('');
  const [editing, setEditing] = useState(false);

  const logs = useMemo(
    () => snapshot.logs.filter((l) => l.habitId === id && l.deletedAt === null),
    [snapshot.logs, id],
  );

  const derived = useMemo(() => {
    if (!habit) return null;
    const byDate = new Map<string, { value: number; backfilled: boolean }>();
    const doneDays = new Set<string>();
    for (const log of logs) {
      byDate.set(log.logDate, { value: log.value, backfilled: log.backfilled });
      if (reached(habit, log.value)) doneDays.add(log.logDate);
    }
    const today = todayKey();
    return {
      streak: computeStreak(doneDays, today),
      rates: rateBuckets({ doneDays, daysOfWeek: habit.daysOfWeek, to: today, createdKey: dateKeyInZone(habit.createdAt) }),
      weeks: heatmapWeeks({
        today,
        weeks: 12,
        target: habit.target,
        daysOfWeek: habit.daysOfWeek,
        logs: byDate,
      }),
    };
  }, [habit, logs]);

  if (!habit || !derived) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.missing}>
          <Text style={styles.missingText}>这个习惯不存在，可能已在别处删除。</Text>
          <Pressable onPress={() => router.back()} style={styles.btn} accessibilityRole="button">
            <Text style={styles.btnText}>返回</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const unit = habitUnit(habit);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.nav}>
        <Pressable onPress={() => router.back()} style={styles.navBtn} accessibilityRole="button">
          <Text style={styles.navText}>返回</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.name}>{habit.name}</Text>
        <Text style={styles.meta}>
          {TYPE_LABEL[habit.type]} · 目标 {habit.target} {unit}
          {habit.daysOfWeek.length === 7 ? ' · 每天' : ` · 每周${habit.daysOfWeek.map((d) => ['一', '二', '三', '四', '五', '六', '日'][d]).join('')}`}
        </Text>

        <View style={styles.stats}>
          <Stat label="当前连续" value={`${derived.streak.current}`} unit="天" />
          <Stat label="历史最长" value={`${derived.streak.longest}`} unit="天" />
        </View>

        <Text style={styles.sectionTitle}>完成率</Text>
        <View style={styles.rates}>
          <Stat label="近 7 天" value={formatRate(derived.rates.week.rate)} />
          <Stat label="近 30 天" value={formatRate(derived.rates.month.rate)} />
          <Stat label="全部" value={formatRate(derived.rates.all.rate)} />
        </View>

        <Text style={styles.sectionTitle}>最近 12 周</Text>
        <View style={styles.heatmap}>
          {derived.weeks.map((week, wi) => (
            <View key={wi} style={styles.heatCol}>
              {week.map((cell) => (
                <View
                  key={cell.date}
                  style={[
                    styles.heatCell,
                    { backgroundColor: cell.scheduled ? LEVEL_COLOR[cell.level] : C.n50 },
                    cell.future && styles.heatFuture,
                  ]}
                  accessibilityLabel={`${cell.date} ${cell.value} ${unit}`}
                />
              ))}
            </View>
          ))}
        </View>
        <Text style={styles.hint}>颜色按占目标的比例分五档；不在排期的日子用淡底。</Text>

        <Text style={styles.sectionTitle}>目标值</Text>
        {editing ? (
          <View style={styles.editRow}>
            <TextInput
              value={targetDraft}
              onChangeText={setTargetDraft}
              keyboardType="number-pad"
              style={styles.input}
              autoFocus
              accessibilityLabel="目标值"
            />
            <Pressable
              onPress={() => {
                const next = Number(targetDraft);
                if (Number.isFinite(next) && next > 0) {
                  void patchHabit(habit.id, { target: Math.round(next) });
                }
                setEditing(false);
              }}
              style={styles.btn}
              accessibilityRole="button"
            >
              <Text style={styles.btnText}>保存</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => {
              setTargetDraft(String(habit.target));
              setEditing(true);
            }}
            style={styles.btn}
            accessibilityRole="button"
            accessibilityLabel={`当前目标 ${habit.target} ${unit}，点击修改`}
          >
            <Text style={styles.btnText}>修改目标（当前 {habit.target} {unit}）</Text>
          </Pressable>
        )}
        <Pressable
          onPress={() => {
            Alert.alert(
              habit.archivedAt === null ? '归档习惯' : '取消归档',
              habit.archivedAt === null
                ? '归档后不再出现在今日列表，历史统计保留。'
                : '回到今日列表继续打卡。',
              [
                { text: '取消', style: 'cancel' },
                {
                  text: '确定',
                  onPress: () => {
                    void archiveHabit(habit.id, habit.archivedAt === null);
                    router.back();
                  },
                },
              ],
            );
          }}
          style={styles.btn}
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>{habit.archivedAt === null ? '归档' : '取消归档'}</Text>
        </Pressable>

        <Pressable
          onPress={() => {
            Alert.alert('删除习惯', `「${habit.name}」及其全部打卡记录都会被删除，不可恢复。`, [
              { text: '取消', style: 'cancel' },
              {
                text: '删除',
                style: 'destructive',
                onPress: () => {
                  void deleteHabit(habit.id);
                  router.back();
                },
              },
            ]);
          }}
          style={[styles.btn, { borderColor: C.danger, marginTop: SP[2] }]}
          accessibilityRole="button"
        >
          <Text style={[styles.btnText, { color: C.danger }]}>删除习惯</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>
        {value}
        {unit ? <Text style={styles.statUnit}> {unit}</Text> : null}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.n0 },
  nav: {
    flexDirection: 'row',
    paddingHorizontal: SP[2],
    paddingVertical: SP[2],
    borderBottomWidth: 1,
    borderBottomColor: C.n200,
  },
  navBtn: { minHeight: HIT - 8, paddingHorizontal: SP[3], justifyContent: 'center' },
  navText: { fontSize: FONT.body, color: C.a500 },
  scroll: { paddingHorizontal: SP[4], paddingBottom: SP[12] },
  name: { marginTop: SP[3], fontSize: FONT.xl, color: C.n900, fontWeight: '600' },
  meta: { marginTop: SP[1], fontSize: FONT.base, color: C.n500 },
  stats: { flexDirection: 'row', gap: SP[3], marginTop: SP[4] },
  rates: { flexDirection: 'row', gap: SP[3] },
  stat: {
    flex: 1,
    borderWidth: 1,
    borderColor: C.n200,
    borderRadius: 2,
    paddingVertical: SP[3],
    paddingHorizontal: SP[3],
  },
  statValue: { fontSize: FONT.lg, color: C.n900, fontWeight: '600' },
  statUnit: { fontSize: FONT.sm, color: C.n500, fontWeight: '400' },
  statLabel: { marginTop: SP[1], fontSize: FONT.xs, color: C.n500 },
  sectionTitle: {
    marginTop: SP[6],
    marginBottom: SP[2],
    fontSize: FONT.xs,
    color: C.n500,
    letterSpacing: 1,
  },
  heatmap: { flexDirection: 'row', gap: 3 },
  heatCol: { gap: 3 },
  heatCell: { width: 12, height: 12, borderRadius: 2 },
  heatFuture: { borderWidth: 1, borderColor: C.n300, borderStyle: 'dashed' },
  hint: { marginTop: SP[2], fontSize: FONT.xs, color: C.n500, lineHeight: 16 },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: SP[2] },
  input: {
    flex: 1,
    height: HIT,
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
    paddingHorizontal: SP[3],
    fontSize: FONT.body,
    color: C.n900,
  },
  btn: {
    marginTop: SP[2],
    minHeight: HIT,
    paddingHorizontal: SP[4],
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: { fontSize: FONT.body, color: C.n900 },
  missing: { flex: 1, justifyContent: 'center', paddingHorizontal: SP[4], gap: SP[4] },
  missingText: { fontSize: FONT.body, color: C.n700 },
});
