import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { describeRrule, formatDateLabel } from '@grid/core';
import { GanttChart, type GanttItem } from '../../src/components/GanttChart';
import { useApp } from '../../src/store';
import { C, FONT, HIT, SP } from '../../src/theme';

type Status = 'open' | 'done' | 'all';
type GroupMode = 'flat' | 'tag';
type ViewMode = 'list' | 'gantt';

const STATUS_LABEL: Record<Status, string> = { open: '未完成', done: '已完成', all: '全部' };
const NO_TAG = '__none__';

export default function ListScreen() {
  const { snapshot, toggleTask } = useApp();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const todayKey = (() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  })();
  const [status, setStatus] = useState<Status>('open');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // 按日期查看：null = 全部
  const [dateFilter, setDateFilter] = useState<string | null>(null);
  const [mode, setMode] = useState<GroupMode>('flat');
  // 甘特是列表的另一种排布，不是独立 tab：底部一排已经 5 个，再加一格就多一次跨页跳转
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  const tagName = useMemo(() => {
    const map = new Map(snapshot.tags.map((tag) => [tag.id, tag.name]));
    return (id: string) => map.get(id) ?? null;
  }, [snapshot.tags]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return snapshot.tasks.filter((task) => {
      if (status === 'open' && task.completedAt !== null) return false;
      if (status === 'done' && task.completedAt === null) return false;
      if (tagFilter === NO_TAG && task.tagIds.length > 0) return false;
      if (tagFilter !== null && tagFilter !== NO_TAG && !task.tagIds.includes(tagFilter)) return false;
      if (dateFilter !== null) {
        const due = task.dueDate;
        let startKey: string | null = null;
        if (task.startAt !== null) {
          const d = new Date(task.startAt);
          const pad = (n: number) => String(n).padStart(2, '0');
          startKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        }
        if (due !== dateFilter && startKey !== dateFilter) return false;
      }
      if (q) {
        const haystack = `${task.title} ${task.note ?? ''}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [snapshot.tasks, status, tagFilter, dateFilter, query]);

  /**
   * 按标签分组。
   *
   * 多标签的任务只出现在**第一个标签**下面，不重复列出 —— 否则「按标签看」
   * 的总条数会比实际任务数多，用户会以为数据重了。
   * 要"这个标签下全部任务"用上方的标签筛选，那是精确的。
   */
  const sections = useMemo(() => {
    if (mode === 'flat') {
      const sorted = [...filtered].sort((a, b) => {
        // 完成的按完成时间倒序排到最前，未完成的仍按象限/手动顺序
        const av = a.completedAt ?? -1;
        const bv = b.completedAt ?? -1;
        if (av !== bv) return bv - av;
        return a.quadrant - b.quadrant || a.sortOrder - b.sortOrder;
      });
      return [{ key: 'all', title: '', data: sorted }];
    }
    const map = new Map<string, typeof filtered>();
    for (const task of filtered) {
      const key = task.tagIds[0] ?? NO_TAG;
      const bucket = map.get(key) ?? [];
      bucket.push(task);
      map.set(key, bucket);
    }
    const rows: { key: string; title: string; data: typeof filtered }[] = [];
    for (const [key, data] of map) {
      rows.push({
        key,
        title: key === NO_TAG ? '未分类' : (tagName(key) ?? '未知标签'),
        data: data.sort((a, b) => a.sortOrder - b.sortOrder),
      });
    }
    rows.sort((a, b) => (a.key === NO_TAG ? 1 : b.key === NO_TAG ? -1 : a.title.localeCompare(b.title)));
    return rows;
  }, [filtered, mode, tagName]);

  const openCount = filtered.filter((t) => t.completedAt === null).length;

  const ganttItems = useMemo<GanttItem[]>(() => {
    const listName = new Map(snapshot.lists.map((l) => [l.id, l.name]));
    return filtered.map((task) => {
      const start = task.startAt ?? (task.dueDate ? new Date(`${task.dueDate}T00:00:00`).getTime() : null);
      const end = task.endAt ?? (start === null ? null : start + 86_400_000);
      return {
        id: task.id,
        title: task.title,
        start,
        end,
        done: task.completedAt !== null,
        groupName: listName.get(task.listId) ?? '收件箱',
      };
    });
  }, [filtered, snapshot.lists]);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.head}>
        <View style={styles.headLeft}>
          <Text style={styles.title}>列表</Text>
          <Text style={styles.sub}>
            {filtered.length} 条 · 其中 {openCount} 条未完成
          </Text>
        </View>
        <View style={styles.segments}>
          {(['list', 'gantt'] as ViewMode[]).map((key) => (
            <Pressable
              key={key}
              onPress={() => setViewMode(key)}
              style={[styles.seg, viewMode === key && styles.segOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: viewMode === key }}
            >
              <Text style={[styles.segText, viewMode === key && styles.onText]}>
                {key === 'list' ? '列表' : '甘特'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.searchWrap}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="搜索标题与备注"
          placeholderTextColor={C.n400}
          style={styles.search}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>

      <View style={styles.statusRow}>
        {(['open', 'done', 'all'] as Status[]).map((key) => (
          <Pressable
            key={key}
            onPress={() => setStatus(key)}
            style={[styles.chip, status === key && styles.chipOn]}
            accessibilityRole="button"
            accessibilityState={{ selected: status === key }}
          >
            <Text style={[styles.chipText, status === key && styles.chipTextOn]}>{STATUS_LABEL[key]}</Text>
          </Pressable>
        ))}
        <View style={styles.spacer} />
        <Pressable
          onPress={() => setMode(mode === 'flat' ? 'tag' : 'flat')}
          style={[styles.chip, mode === 'tag' && styles.chipOn]}
          accessibilityRole="button"
          accessibilityLabel={mode === 'tag' ? '切换为平铺' : '按标签分组'}
        >
          <Text style={[styles.chipText, mode === 'tag' && styles.chipTextOn]}>
            {mode === 'tag' ? '按标签分组' : '平铺'}
          </Text>
        </Pressable>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.dateScroll} contentContainerStyle={styles.dateRow}>
        {[
          { label: '全部日期', value: null as string | null },
          { label: '今日', value: todayKey },
          {
            label: '明日',
            value: (() => {
              const d = new Date();
              d.setDate(d.getDate() + 1);
              const pad = (n: number) => String(n).padStart(2, '0');
              return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            })(),
          },
        ].map((opt) => (
          <Pressable
            key={opt.label}
            onPress={() => setDateFilter(opt.value)}
            style={[styles.chip, dateFilter === opt.value && styles.chipOn]}
            accessibilityRole="button"
            accessibilityState={{ selected: dateFilter === opt.value }}
          >
            <Text style={[styles.chipText, dateFilter === opt.value && styles.chipTextOn]}>{opt.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tagScroll}
        contentContainerStyle={styles.tagRow}
      >
        <Pressable
          onPress={() => setTagFilter(null)}
          style={[styles.chip, tagFilter === null && styles.chipOn]}
          accessibilityRole="button"
        >
          <Text style={[styles.chipText, tagFilter === null && styles.chipTextOn]}>全部标签</Text>
        </Pressable>
        {snapshot.tags.map((tag) => (
          <Pressable
            key={tag.id}
            onPress={() => setTagFilter(tagFilter === tag.id ? null : tag.id)}
            style={[styles.chip, tagFilter === tag.id && styles.chipOn]}
            accessibilityRole="button"
          >
            <Text style={[styles.chipText, tagFilter === tag.id && styles.chipTextOn]}>#{tag.name}</Text>
          </Pressable>
        ))}
        <Pressable
          onPress={() => setTagFilter(tagFilter === NO_TAG ? null : NO_TAG)}
          style={[styles.chip, tagFilter === NO_TAG && styles.chipOn]}
          accessibilityRole="button"
        >
          <Text style={[styles.chipText, tagFilter === NO_TAG && styles.chipTextOn]}>未分类</Text>
        </Pressable>
      </ScrollView>

      {viewMode === 'gantt' ? (
        <GanttChart items={ganttItems} onOpen={(id) => router.push(`/task/${id}`)} />
      ) : (
      <FlatList
        data={sections}
        keyExtractor={(section) => section.key}
        contentContainerStyle={filtered.length === 0 ? styles.emptyWrap : styles.list}
        ListEmptyComponent={
          <View>
            <Text style={styles.emptyTitle}>没有匹配的待办</Text>
            <Text style={styles.emptyHint}>换个关键词，或把状态切到「全部」</Text>
          </View>
        }
        renderItem={({ item: section }) => (
          <View>
            {section.title ? (
              <View style={styles.sectionHead}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                <Text style={styles.sectionCount}>{section.data.length}</Text>
              </View>
            ) : null}
            {section.data.map((task) => {
              const done = task.completedAt !== null;
              return (
                <View key={task.id} style={styles.row}>
                  <Pressable
                    onPress={() => void toggleTask(task.id)}
                    hitSlop={8}
                    style={styles.check}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: done }}
                    accessibilityLabel={done ? `取消完成「${task.title}」` : `完成「${task.title}」`}
                  >
                    <View style={[styles.checkBox, done && styles.checkBoxDone]}>
                      {done ? <Text style={styles.checkMark}>✓</Text> : null}
                    </View>
                  </Pressable>

                  <Pressable
                    onPress={() => router.push(`/task/${task.id}`)}
                    style={styles.rowBody}
                    accessibilityRole="button"
                    accessibilityLabel={`打开「${task.title}」`}
                  >
                    <Text style={[styles.rowTitle, done && styles.rowTitleDone]} numberOfLines={2}>
                      {task.title}
                    </Text>
                    <View style={styles.metaRow}>
                      {(() => {
                        const repeat = describeRrule(task.rrule);
                        return repeat ? <Text style={styles.metaRepeat}>↻ {repeat}</Text> : null;
                      })()}
                      {task.dueDate ? (
                        <Text style={[styles.meta, task.dueDate === todayKey && styles.metaToday]}>
                          {formatDateLabel(task.dueDate)}
                        </Text>
                      ) : null}
                      {task.tagIds
                        .slice(0, 3)
                        .map((id) => {
                          const name = tagName(id);
                          return name ? (
                            <Text key={id} style={styles.meta}>
                              #{name}
                            </Text>
                          ) : null;
                        })}
                    </View>
                  </Pressable>
                </View>
              );
            })}
          </View>
        )}
      />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.n0 },
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: SP[4],
    paddingTop: SP[4],
    paddingBottom: SP[2],
    gap: SP[2],
  },
  headLeft: { flex: 1 },
  segments: { flexDirection: 'row', gap: 1, backgroundColor: C.n200, borderWidth: 1, borderColor: C.n200 },
  seg: {
    height: 30,
    paddingHorizontal: SP[3],
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.n0,
  },
  segOn: { backgroundColor: C.n900 },
  segText: { fontSize: FONT.sm, color: C.n600 },
  onText: { color: C.n0 },
  title: { fontSize: FONT.xl, color: C.n900, fontWeight: '600' },
  sub: { marginTop: SP[1], fontSize: FONT.base, color: C.n500 },
  searchWrap: { paddingHorizontal: SP[4], paddingTop: SP[2] },
  search: {
    minHeight: HIT,
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
    paddingHorizontal: SP[3],
    fontSize: FONT.body,
    color: C.n900,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: SP[2], paddingHorizontal: SP[4], paddingTop: SP[3] },
  spacer: { flex: 1 },
  // 高度写死：横向 ScrollView 会按内容撑开，chips 高度一变整条就跳，
  // 表现为"标签突然变高"。固定 48 与 chips 的 34 高对齐居中。
  dateScroll: { height: 44 },
  dateRow: { gap: SP[2], paddingHorizontal: SP[4], alignItems: 'center', height: '100%' },
  metaToday: { color: C.a500, fontWeight: '600' },
  tagScroll: { height: 48 },
  tagRow: { gap: SP[2], paddingHorizontal: SP[4], alignItems: 'center', height: '100%' },
  chip: {
    height: 34,
    paddingHorizontal: SP[3],
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: C.n300,
    borderRadius: 2,
  },
  chipOn: { backgroundColor: C.a500, borderColor: C.a500 },
  chipText: { fontSize: FONT.sm, color: C.n600 },
  chipTextOn: { color: C.n0 },
  list: { paddingHorizontal: SP[4], paddingBottom: SP[8] },
  emptyWrap: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: SP[4] },
  emptyTitle: { fontSize: FONT.md, color: C.n700 },
  emptyHint: { marginTop: SP[1], fontSize: FONT.base, color: C.n500 },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingTop: SP[3],
    paddingBottom: SP[1],
    borderBottomWidth: 1,
    borderBottomColor: C.n200,
  },
  sectionTitle: { fontSize: FONT.sm, color: C.n600, fontWeight: '600' },
  sectionCount: { fontSize: FONT.xs, color: C.n400 },
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: C.n100 },
  check: { width: HIT, height: HIT + 8, alignItems: 'center', justifyContent: 'center' },
  checkBox: {
    width: 18,
    height: 18,
    borderWidth: 1.5,
    borderColor: C.n500,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBoxDone: { backgroundColor: C.a500, borderColor: C.a500 },
  checkMark: { color: C.n0, fontSize: 12, lineHeight: 14 },
  rowBody: { flex: 1, paddingVertical: SP[2], paddingRight: SP[2] },
  rowTitle: { fontSize: FONT.body, color: C.n900, lineHeight: 21 },
  rowTitleDone: { color: C.n400, textDecorationLine: 'line-through' },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SP[2], marginTop: 2 },
  meta: { fontSize: FONT.xs, color: C.n500 },
  metaRepeat: { fontSize: FONT.xs, color: C.a500 },
});
