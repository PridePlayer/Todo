import {
  QUADRANT_META,
  QUADRANT_ORDER,
  WEEKDAYS,
  buildRrule,
  parseRrule,
  rruleFromPreset,
  weekdayOf,
  type Quadrant,
  type RrulePreset,
  type Weekday,
} from '@grid/core';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../../src/store';
import { PermissionGuide } from '../../src/notify/PermissionGuide';
import { currentPermission, taskAnchor, taskReminderAt } from '../../src/notify/schedule';
import { C, FONT, HIT, SP } from '../../src/theme';

const WEEKDAY_CN: Record<Weekday, string> = { MO: '一', TU: '二', WE: '三', TH: '四', FR: '五', SA: '六', SU: '日' };

/**
 * 提醒只能选"提前量"，不能选绝对时刻。
 *
 * 因为提醒的锚点是任务的开始时间：选绝对时刻的话，任务一改期，
 * 提醒就停在旧时间上，而"改了会，提醒还在昨天响"是没人能一眼看出来的错误。
 */
const REMIND_OPTIONS: { label: string; value: number | null }[] = [
  { label: '不提醒', value: null },
  { label: '准时', value: 0 },
  { label: '提前 15 分', value: 15 },
  { label: '提前 1 小时', value: 60 },
  { label: '提前 1 天', value: 1440 },
];

const REPEAT_LABEL: { key: RrulePreset | 'none'; label: string }[] = [
  { key: 'none', label: '不重复' },
  { key: 'daily', label: '每天' },
  { key: 'weekday', label: '工作日' },
  { key: 'weekly', label: '每周' },
  { key: 'monthly', label: '每月' },
  { key: 'monthly-last-workday', label: '每月最后工作日' },
  { key: 'yearly', label: '每年' },
];

function dateKey(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return dateInput(d.getTime());
}

function dateInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function TaskDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { snapshot, patchTask, deleteTask, ensureTag, toggleTask } = useApp();

  const task = snapshot.tasks.find((t) => t.id === id);
  const [title, setTitle] = useState(task?.title ?? '');
  const [note, setNote] = useState(task?.note ?? '');
  const [dueDate, setDueDate] = useState(task?.dueDate ?? '');
  const [location, setLocation] = useState(task?.location ?? '');
  const [tagInput, setTagInput] = useState('');
  // 必须在这里声明，不能放到 early return 之后：hooks 的数量在每次渲染里都要一致，
  // task 不存在时提前 return 会让两者不等，React 直接抛 "Rendered fewer hooks"
  const [repeatDays, setRepeatDays] = useState<Weekday[]>([]);
  const [repeatUntil, setRepeatUntil] = useState('');
  const [guideVisible, setGuideVisible] = useState(false);

  // 同步拉取可能在详情页打开后才把这条写进来，等它到了再填一次
  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setNote(task.note ?? '');
    setDueDate(task.dueDate ?? '');
    setLocation(task.location ?? '');
    // 同步拉取可能在页面打开后才改了规则，这里要跟着刷
    setRepeatDays(task.rrule ? (parseRrule(task.rrule).byDay ?? []) : []);
    setRepeatUntil(task.rrule && parseRrule(task.rrule).until ? dateInput(task.rrule ? parseRrule(task.rrule).until! : 0) : '');
  }, [task?.id, task?.rrule]);

  if (!task) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.missing}>
          <Text style={styles.missingText}>这条待办不存在，可能已在别处删除。</Text>
          <Pressable onPress={() => router.back()} style={styles.btn} accessibilityRole="button">
            <Text style={styles.btnText}>返回</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const done = task.completedAt !== null;

  function saveTitle() {
    const next = title.trim();
    if (!next) {
      setTitle(task!.title);
      return;
    }
    if (next !== task!.title) void patchTask(task!.id, { title: next });
  }

  function saveNote() {
    const next = note.trim() === '' ? null : note;
    if (next !== task!.note) void patchTask(task!.id, { note: next });
  }

  function setQuadrant(q: Quadrant) {
    // 只传两个开关，quadrant 由 patchTask 内部按 quadrantOf 派生。
    // 拆成两次 patch 的话，第二次基于的 snapshot 还没更新，
    // 会把第一次写进去的值又盖回去。
    const bits = 4 - q;
    void patchTask(task!.id, { important: (bits & 2) !== 0, urgent: (bits & 1) !== 0 });
  }

  function setDue(value: string | null) {
    setDueDate(value ?? '');
    void patchTask(task!.id, { dueDate: value });
  }

  function commitRepeat(preset: RrulePreset | 'none', days: Weekday[]) {
    const anchor = dueDate ? new Date(`${dueDate}T09:00:00`).getTime() : Date.now();
    const d = new Date(anchor);
    // "每周"要保留用户已勾的星期：否则一碰下拉框就退回"按当天星期"，
    // 周一勾选的"每周三"会被静默改掉
    const rrule =
      preset === 'none'
        ? null
        : buildRrule({
            freq: preset === 'daily' ? 'DAILY' : preset === 'monthly' || preset === 'monthly-last-workday' ? 'MONTHLY' : preset === 'yearly' ? 'YEARLY' : 'WEEKLY',
            byDay: preset === 'weekly' ? (days.length > 0 ? days : [weekdayOf(d)]) : preset === 'weekday' ? ['MO', 'TU', 'WE', 'TH', 'FR'] : preset === 'monthly-last-workday' ? ['FR'] : undefined,
            bySetPos: preset === 'monthly-last-workday' ? -1 : null,
            byMonthDay: preset === 'monthly' ? [d.getDate()] : undefined,
            until: repeatUntil ? new Date(`${repeatUntil}T23:59:59`).getTime() : null,
          });
    void patchTask(task!.id, { rrule });
  }

  function applyRepeat(preset: RrulePreset | 'none') {
    commitRepeat(preset, repeatDays);
  }

  function toggleRepeatDay(day: Weekday) {
    const next = repeatDays.includes(day)
      ? repeatDays.filter((d) => d !== day)
      : [...repeatDays, day].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
    setRepeatDays(next);
    commitRepeat('weekly', next);
  }

  function toggleTag(tagId: string) {
    const has = task!.tagIds.includes(tagId);
    void patchTask(task!.id, { tagIds: has ? task!.tagIds.filter((id) => id !== tagId) : [...task!.tagIds, tagId] });
  }

  async function addTag() {
    const name = tagInput.trim().replace(/^#/, '');
    if (!name) return;
    setTagInput('');
    const tag = await ensureTag(name);
    if (!task!.tagIds.includes(tag.id)) {
      void patchTask(task!.id, { tagIds: [...task!.tagIds, tag.id] });
    }
  }

  function confirmDelete() {
    Alert.alert('删除待办', `「${task!.title}」将从所有设备移除。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void deleteTask(task!.id);
          router.back();
        },
      },
    ]);
  }

  // 当前重复规则反查成预设：rrule 里没有 FREQ 之外的定位信息，
  // 逐条比对字符串是唯一可靠的办法，用 includes 判断会误命中 COUNT 等后缀
  const currentPreset: RrulePreset | 'none' | 'weekly-custom' = (() => {
    if (!task.rrule) return 'none';
    const rule = parseRrule(task.rrule);
    // 带自选星期的每周：预设里没有"MO,WE"这种，要走周几按钮
    if (rule.freq === 'WEEKLY' && (rule.byDay?.length ?? 0) > 0 && rule.bySetPos === null && rule.byMonthDay === null) {
      return rule.byDay!.join(',') === 'MO,TU,WE,TH,FR' ? 'weekday' : 'weekly';
    }
    for (const item of REPEAT_LABEL) {
      if (item.key === 'none') continue;
      const anchor = task.startAt ?? (task.dueDate ? new Date(`${task.dueDate}T09:00:00`).getTime() : Date.now());
      if (rruleFromPreset(item.key, anchor) === task.rrule) return item.key;
    }
    // 认不出来的规则原样保留（比如导入的 COUNT=6），不谎报成"不重复"
    return 'weekly-custom';
  })();


  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.nav}>
        <Pressable onPress={() => router.back()} style={styles.navBtn} accessibilityRole="button">
          <Text style={styles.navText}>返回</Text>
        </Pressable>
        <Pressable
          onPress={() => void toggleTask(task.id)}
          style={styles.navBtn}
          accessibilityRole="button"
        >
          <Text style={styles.navText}>{done ? '取消完成' : '标记完成'}</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <TextInput
          value={title}
          onChangeText={setTitle}
          onBlur={saveTitle}
          style={[styles.titleInput, done && styles.titleDone]}
          multiline
          placeholder="标题"
          placeholderTextColor={C.n400}
          accessibilityLabel="任务标题"
        />

        <Section title="象限">
          <View style={styles.quadrantRow}>
            {QUADRANT_ORDER.map((q) => {
              const on = task.quadrant === q;
              return (
                <Pressable
                  key={q}
                  onPress={() => setQuadrant(q)}
                  style={[styles.quadrant, on && styles.quadrantOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                >
                  <Text style={[styles.quadrantNo, on && styles.onText]}>{QUADRANT_META[q].no}</Text>
                  <Text style={[styles.quadrantTitle, on && styles.onText]} numberOfLines={2}>
                    {QUADRANT_META[q].title}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {/* 没有"未分类"选项：quadrant 是必填的派生字段，04 就是它的收件箱位置 */}
          <Text style={styles.hint}>新建时默认落在 04，方便先收下来再分类。</Text>
        </Section>

        <Section title="优先级">
          <View style={styles.row}>
            {[0, 1, 2, 3].map((level) => {
              const on = task.priority === level;
              return (
                <Pressable
                  key={level}
                  onPress={() => void patchTask(task.id, { priority: level })}
                  style={[styles.chip, on && styles.chipOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                >
                  <Text style={[styles.chipText, on && styles.onText]}>
                    {['无', '低', '中', '高'][level]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Section>

        <Section title="日期">
          <View style={styles.row}>
            {[
              { label: '今天', value: dateKey(0) },
              { label: '明天', value: dateKey(1) },
            ].map((item) => (
              <Pressable
                key={item.label}
                onPress={() => setDue(item.value)}
                style={[styles.chip, dueDate === item.value && styles.chipOn]}
                accessibilityRole="button"
              >
                <Text style={[styles.chipText, dueDate === item.value && styles.onText]}>{item.label}</Text>
              </Pressable>
            ))}
            <Pressable
              onPress={() => setDue(null)}
              style={[styles.chip, dueDate === '' && styles.chipOn]}
              accessibilityRole="button"
            >
              <Text style={[styles.chipText, dueDate === '' && styles.onText]}>无</Text>
            </Pressable>
          </View>
          <TextInput
            value={dueDate}
            onChangeText={setDueDate}
            onBlur={() => {
              if (dueDate !== (task.dueDate ?? '')) setDue(dueDate === '' ? null : dueDate);
            }}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={C.n400}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Section>

        <Section title="提醒">
          <View style={styles.row}>
            {REMIND_OPTIONS.map((item) => {
              const on = (task.remindLeadMinutes ?? null) === item.value;
              return (
                <Pressable
                  key={item.label}
                  onPress={() => {
                    void patchTask(task.id, { remindLeadMinutes: item.value });
                    // 第一次设提醒就把权限引导带出来：设了提醒却不会响，
                    // 用户第一反应是"这功能坏了"，而不是"我该去给权限"
                    if (item.value !== null) {
                      void currentPermission().then((state) => {
                        if (state !== 'granted') setGuideVisible(true);
                      });
                    }
                  }}
                  style={[styles.chip, on && styles.chipOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                >
                  <Text style={[styles.chipText, on && styles.onText]}>{item.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.hint}>
            {taskAnchor(task) === null
              ? '先在上面设一个日期，提醒才有可依据的时刻。'
              : (() => {
                  const at = taskReminderAt({ ...task, remindLeadMinutes: task.remindLeadMinutes ?? 0 });
                  if (task.remindLeadMinutes === null) return '当前不提醒。';
                  if (at === null) return '这条任务缺少可用的时间点。';
                  const d = new Date(at);
                  const pad = (n: number) => String(n).padStart(2, '0');
                  return `将在 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())} 提醒`;
                })()}
          </Text>
        </Section>

        <Section title="重复">
          <View style={styles.row}>
            {REPEAT_LABEL.map((item) => (
              <Pressable
                key={item.key}
                onPress={() => applyRepeat(item.key)}
                style={[styles.chip, currentPreset === item.key && styles.chipOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: currentPreset === item.key }}
              >
                <Text style={[styles.chipText, currentPreset === item.key && styles.onText]}>{item.label}</Text>
              </Pressable>
            ))}
          </View>

          {(currentPreset === 'weekly' || currentPreset === 'weekly-custom') && (
            <View style={[styles.row, { marginTop: SP[2] }]} accessibilityLabel="重复的星期">
              {WEEKDAYS.map((day) => {
                const on = repeatDays.includes(day);
                return (
                  <Pressable
                    key={day}
                    onPress={() => toggleRepeatDay(day)}
                    style={[styles.chip, on && styles.chipOn]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                  >
                    <Text style={[styles.chipText, on && styles.onText]}>{WEEKDAY_CN[day]}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          <View style={[styles.row, { marginTop: SP[2], alignItems: 'center' }]}>
            <Text style={[styles.hint, { marginTop: 0 }]}>截止于</Text>
            <TextInput
              value={repeatUntil}
              onChangeText={setRepeatUntil}
              onBlur={() => commitRepeat(currentPreset === 'weekly-custom' ? 'weekly' : (currentPreset as RrulePreset | 'none'), repeatDays)}
              placeholder="YYYY-MM-DD，留空一直重复"
              placeholderTextColor={C.n400}
              style={[styles.input, { flex: 1, marginTop: 0 }]}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <Text style={styles.hint}>
            重复以第一条的日期为锚点。改日期后再点一次重复，才会按新日期重算。
          </Text>
        </Section>

        <Section title="地点">
          <TextInput
            value={location}
            onChangeText={setLocation}
            onBlur={() => {
              const next = location.trim() === '' ? null : location.trim();
              if (next !== task.location) void patchTask(task.id, { location: next });
            }}
            placeholder="可留空"
            placeholderTextColor={C.n400}
            style={styles.input}
          />
        </Section>

        <Section title="标签">
          <View style={styles.row}>
            {snapshot.tags.length === 0 ? (
              <Text style={styles.hint}>还没有标签，在下面输入一个回车创建。</Text>
            ) : (
              snapshot.tags.map((tag) => {
                const on = task.tagIds.includes(tag.id);
                return (
                  <Pressable
                    key={tag.id}
                    onPress={() => toggleTag(tag.id)}
                    style={[styles.chip, on && styles.chipOn]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                  >
                    <Text style={[styles.chipText, on && styles.onText]}>#{tag.name}</Text>
                  </Pressable>
                );
              })
            )}
          </View>
          <View style={styles.tagInputRow}>
            <TextInput
              value={tagInput}
              onChangeText={setTagInput}
              onSubmitEditing={() => void addTag()}
              placeholder="新标签，回车添加"
              placeholderTextColor={C.n400}
              style={[styles.input, styles.flex]}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
            />
            <Pressable onPress={() => void addTag()} style={styles.tagAdd} accessibilityRole="button">
              <Text style={styles.tagAddText}>添加</Text>
            </Pressable>
          </View>
        </Section>

        <Section title="备注">
          <TextInput
            value={note}
            onChangeText={setNote}
            onBlur={saveNote}
            multiline
            placeholder="背景、链接、要问的人…"
            placeholderTextColor={C.n400}
            style={[styles.input, styles.note]}
          />
        </Section>

        <Pressable onPress={confirmDelete} style={styles.danger} accessibilityRole="button">
          <Text style={styles.dangerText}>删除这条待办</Text>
        </Pressable>
      </ScrollView>

      <PermissionGuide visible={guideVisible} onClose={() => setGuideVisible(false)} />
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.n0 },
  nav: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: SP[2],
    paddingVertical: SP[2],
    borderBottomWidth: 1,
    borderBottomColor: C.n200,
  },
  navBtn: { minHeight: HIT - 8, paddingHorizontal: SP[3], justifyContent: 'center' },
  navText: { fontSize: FONT.body, color: C.a500 },
  scroll: { paddingHorizontal: SP[4], paddingBottom: SP[12] },
  titleInput: {
    marginTop: SP[3],
    fontSize: FONT.lg,
    color: C.n900,
    lineHeight: 28,
    paddingVertical: SP[2],
    borderBottomWidth: 1,
    borderBottomColor: C.n200,
  },
  titleDone: { color: C.n400, textDecorationLine: 'line-through' },
  section: { marginTop: SP[6] },
  sectionTitle: { fontSize: FONT.xs, color: C.n500, letterSpacing: 1, marginBottom: SP[2] },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: SP[2] },
  quadrantRow: { flexDirection: 'row', gap: SP[2] },
  quadrant: {
    flex: 1,
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
    paddingVertical: SP[2],
    paddingHorizontal: SP[2],
    minHeight: 56,
  },
  quadrantOn: { backgroundColor: C.a500, borderColor: C.a500 },
  quadrantNo: { fontSize: FONT.xs, color: C.n400 },
  quadrantTitle: { marginTop: 2, fontSize: FONT.sm, color: C.n700 },
  onText: { color: C.n0 },
  chip: {
    height: 36,
    paddingHorizontal: SP[3],
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
  },
  chipOn: { backgroundColor: C.a500, borderColor: C.a500 },
  chipText: { fontSize: FONT.sm, color: C.n700 },
  input: {
    marginTop: SP[2],
    minHeight: HIT,
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
    paddingHorizontal: SP[3],
    fontSize: FONT.body,
    color: C.n900,
  },
  note: { minHeight: 96, textAlignVertical: 'top', paddingTop: SP[2] },
  flex: { flex: 1 },
  tagInputRow: { flexDirection: 'row', alignItems: 'center', gap: SP[2] },
  tagAdd: {
    marginTop: SP[2],
    minHeight: HIT,
    paddingHorizontal: SP[3],
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
  },
  tagAddText: { fontSize: FONT.sm, color: C.n700 },
  hint: { marginTop: SP[2], fontSize: FONT.xs, color: C.n500, lineHeight: 16 },
  danger: {
    marginTop: SP[8],
    minHeight: HIT,
    borderWidth: 1,
    borderColor: C.danger,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerText: { fontSize: FONT.body, color: C.danger },
  missing: { flex: 1, justifyContent: 'center', paddingHorizontal: SP[4], gap: SP[4] },
  missingText: { fontSize: FONT.body, color: C.n700 },
  btn: {
    minHeight: HIT,
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: { fontSize: FONT.body, color: C.n900 },
});
