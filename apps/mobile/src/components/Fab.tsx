import { buildRrule, weekdayOf, WEEKDAYS, type RrulePreset, type Weekday } from '@grid/core';
import { useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useApp } from '../store';
import { C, FONT, HIT, SP } from '../theme';

type Kind = 'task' | 'event';

const REPEAT_LABEL: { key: RrulePreset | 'none'; label: string }[] = [
  { key: 'none', label: '不重复' },
  { key: 'daily', label: '每天' },
  { key: 'weekday', label: '工作日' },
  { key: 'weekly', label: '每周' },
  { key: 'monthly', label: '每月' },
  { key: 'yearly', label: '每年' },
];

const WEEKDAY_CN: Record<Weekday, string> = { MO: '一', TU: '二', WE: '三', TH: '四', FR: '五', SA: '六', SU: '日' };

/**
 * 全局悬浮新建。
 *
 * 要求是"非侵入"：Modal 用透明遮罩，卡片浮在下半屏，Esc/点遮罩就关，
 * 不锁背景滚动（新建是高频动作，不该每次都要重建上下文）。
 */
export function Fab() {
  const { snapshot, createTask, ensureTag } = useApp();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('task');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [location, setLocation] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [repeat, setRepeat] = useState<RrulePreset | 'none'>('none');
  const [repeatDays, setRepeatDays] = useState<Weekday[]>([]);
  const [repeatUntil, setRepeatUntil] = useState('');
  const [busy, setBusy] = useState(false);

  function reset() {
    setTitle('');
    setDate('');
    setStartTime('');
    setLocation('');
    setTagIds([]);
    setTagDraft('');
    setRepeat('none');
    setRepeatDays([]);
    setRepeatUntil('');
  }

  async function submit() {
    const trimmed = title.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    try {
      const anchor = date ? new Date(`${date}T${startTime || '09:00'}:00`).getTime() : Date.now();
      const rrule =
        repeat === 'none'
          ? null
          : buildRrule({
              freq: repeat === 'daily' ? 'DAILY' : repeat === 'monthly' ? 'MONTHLY' : repeat === 'yearly' ? 'YEARLY' : 'WEEKLY',
              byDay: repeat === 'weekly' ? (repeatDays.length > 0 ? repeatDays : [weekdayOf(new Date(anchor))]) : repeat === 'weekday' ? ['MO', 'TU', 'WE', 'TH', 'FR'] : undefined,
              byMonthDay: repeat === 'monthly' ? [new Date(anchor).getDate()] : undefined,
              until: repeatUntil ? new Date(`${repeatUntil}T23:59:59`).getTime() : null,
            });

      await createTask({
        title: trimmed,
        quadrant: 4,
        dueDate: date || null,
        startAt: kind === 'event' && date && startTime ? anchor : null,
        location: location.trim() || null,
        tagIds,
        rrule,
      });
      reset();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  async function addTag() {
    const name = tagDraft.trim().replace(/^#/, '');
    if (!name) return;
    setTagDraft('');
    const tag = await ensureTag(name);
    if (!tagIds.includes(tag.id)) setTagIds([...tagIds, tag.id]);
  }

  return (
    <>
      {/* 打开弹窗时必须藏起来，否则右下角会叠两个加号 */}
      {!open ? (
        <Pressable
          onPress={() => setOpen(true)}
          style={[styles.fab, { bottom: 56 + insets.bottom + SP[4] }]}
          accessibilityRole="button"
          accessibilityLabel="快速新建"
        >
          <Text style={styles.fabPlus}>＋</Text>
        </Pressable>
      ) : null}

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} accessibilityLabel="关闭" />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetWrap}>
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <ScrollView keyboardShouldPersistTaps="handled">
              <View style={styles.kinds}>
                {(['task', 'event'] as Kind[]).map((k) => (
                  <Pressable
                    key={k}
                    onPress={() => setKind(k)}
                    style={[styles.kind, kind === k && styles.kindOn]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: kind === k }}
                  >
                    <Text style={[styles.kindText, kind === k && styles.onText]}>{k === 'task' ? '待办' : '日程'}</Text>
                  </Pressable>
                ))}
              </View>

              <TextInput
                value={title}
                onChangeText={setTitle}
                placeholder={kind === 'task' ? '要做什么？' : '什么安排？'}
                placeholderTextColor={C.n400}
                style={styles.title}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={() => void submit()}
              />

              <Field label="日期">
                <TextInput
                  value={date}
                  onChangeText={setDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={C.n400}
                  style={styles.input}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </Field>

              {kind === 'event' ? (
                <Field label="开始时间">
                  <TextInput
                    value={startTime}
                    onChangeText={setStartTime}
                    placeholder="HH:mm"
                    placeholderTextColor={C.n400}
                    style={styles.input}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </Field>
              ) : null}

              <Field label="地点">
                <TextInput
                  value={location}
                  onChangeText={setLocation}
                  placeholder="可留空"
                  placeholderTextColor={C.n400}
                  style={styles.input}
                />
              </Field>

              <Field label="标签">
                <View style={styles.tagWrap}>
                  {snapshot.tags.map((tag) => {
                    const on = tagIds.includes(tag.id);
                    return (
                      <Pressable
                        key={tag.id}
                        onPress={() => setTagIds(on ? tagIds.filter((x) => x !== tag.id) : [...tagIds, tag.id])}
                        style={[styles.chip, on && styles.chipOn]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                      >
                        <Text style={[styles.chipText, on && styles.onText]}>#{tag.name}</Text>
                      </Pressable>
                    );
                  })}
                  <TextInput
                    value={tagDraft}
                    onChangeText={setTagDraft}
                    onSubmitEditing={() => void addTag()}
                    placeholder="新标签"
                    placeholderTextColor={C.n400}
                    style={styles.tagInput}
                    autoCapitalize="none"
                    returnKeyType="done"
                  />
                </View>
              </Field>

              <Field label="重复">
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tagRow}>
                  {REPEAT_LABEL.map((o) => (
                    <Pressable
                      key={o.key}
                      onPress={() => setRepeat(o.key)}
                      style={[styles.chip, repeat === o.key && styles.chipOn]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: repeat === o.key }}
                    >
                      <Text style={[styles.chipText, repeat === o.key && styles.onText]}>{o.label}</Text>
                    </Pressable>
                  ))}
                </ScrollView>

                {repeat === 'weekly' ? (
                  <View style={[styles.tagWrap, { marginTop: SP[2] }]}>
                    {WEEKDAYS.map((d) => {
                      const on = repeatDays.includes(d);
                      return (
                        <Pressable
                          key={d}
                          onPress={() =>
                            setRepeatDays(on ? repeatDays.filter((x) => x !== d) : [...repeatDays, d].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b)))
                          }
                          style={[styles.chip, on && styles.chipOn]}
                          accessibilityRole="button"
                          accessibilityState={{ selected: on }}
                        >
                          <Text style={[styles.chipText, on && styles.onText]}>{WEEKDAY_CN[d]}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}

                {repeat !== 'none' ? (
                  <TextInput
                    value={repeatUntil}
                    onChangeText={setRepeatUntil}
                    placeholder="截止日期 YYYY-MM-DD，留空一直重复"
                    placeholderTextColor={C.n400}
                    style={[styles.input, { marginTop: SP[2] }]}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                ) : null}
              </Field>

            </ScrollView>

            {/* 固定在底部：表单字段多，滚到底才看得到按钮等于强制多滚一次 */}
            <View style={styles.actions}>
              <Pressable onPress={() => setOpen(false)} style={styles.ghost} accessibilityRole="button">
                <Text style={styles.ghostText}>取消</Text>
              </Pressable>
              <Pressable
                onPress={() => void submit()}
                disabled={title.trim() === ''}
                style={[styles.primary, title.trim() === '' && styles.primaryDisabled]}
                accessibilityRole="button"
              >
                <Text style={styles.primaryText}>创建</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: SP[4],
    bottom: SP[8],
    width: 52,
    height: 52,
    borderRadius: 2,
    backgroundColor: C.a500,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 30,
  },
  fabPlus: { color: C.n0, fontSize: 28, lineHeight: 32 },
  backdrop: { flex: 1, backgroundColor: 'rgba(10,10,10,0.28)' },
  sheetWrap: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  sheet: {
    backgroundColor: C.n0,
    borderTopWidth: 1,
    borderTopColor: C.n200,
    paddingHorizontal: SP[4],
    paddingTop: SP[2],
    paddingBottom: SP[8],
    maxHeight: '86%',
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 3,
    backgroundColor: C.n200,
    borderRadius: 2,
    marginBottom: SP[3],
  },
  kinds: { flexDirection: 'row', gap: 1, backgroundColor: C.n200, borderWidth: 1, borderColor: C.n200 },
  kind: { flex: 1, height: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: C.n0 },
  kindOn: { backgroundColor: C.n900 },
  kindText: { fontSize: FONT.sm, color: C.n600 },
  onText: { color: C.n0 },
  title: {
    marginTop: SP[3],
    height: HIT,
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
    paddingHorizontal: SP[3],
    fontSize: FONT.body,
    color: C.n900,
  },
  field: { marginTop: SP[3] },
  label: { fontSize: FONT.xs, color: C.n500, marginBottom: SP[1] },
  input: {
    height: HIT,
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
    paddingHorizontal: SP[3],
    fontSize: FONT.body,
    color: C.n900,
  },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SP[1], alignItems: 'center' },
  tagRow: { gap: SP[1], alignItems: 'center' },
  chip: {
    height: 32,
    paddingHorizontal: SP[2],
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
  },
  chipOn: { backgroundColor: C.a500, borderColor: C.a500 },
  chipText: { fontSize: FONT.sm, color: C.n700 },
  tagInput: {
    height: 32,
    minWidth: 100,
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
    paddingHorizontal: SP[2],
    fontSize: FONT.sm,
    color: C.n900,
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: SP[2], marginTop: SP[4] },
  ghost: {
    height: HIT,
    paddingHorizontal: SP[4],
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghostText: { fontSize: FONT.body, color: C.n700 },
  primary: {
    height: HIT,
    paddingHorizontal: SP[6],
    borderRadius: 2,
    backgroundColor: C.a500,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryDisabled: { backgroundColor: C.n300 },
  primaryText: { fontSize: FONT.body, color: C.n0 },
});
