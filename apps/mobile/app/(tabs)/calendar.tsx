import { expandSeries, type Occurrence } from '@grid/core';
import { useMemo } from 'react';
import { FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../../src/store';
import { C, FONT, HIT, SP } from '../../src/theme';

const DAY = 86_400_000;
const HORIZON = 30;
const LOOKBACK = 7;
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDays(ts: number, n: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

function clock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Row {
  key: string;
  start: number;
  end: number;
  allDay: boolean;
  title: string;
  location: string | null;
  kind: 'event' | 'task';
  webLink: string | null;
  taskId: string | null;
}

/**
 * 手机上的日历只做「日程」（Agenda）。
 *
 * 不做 7 列周视图：375px 宽度下每列只剩 50px，时间被截成 "08:"，
 * 标题只能显示两个字，那时候"密"不是"紧凑"而是读不出来。
 * Agenda 是 Google Calendar 在手机上的默认形态，因为一屏能看的信息量最大。
 */
export default function CalendarScreen() {
  const { snapshot } = useApp();

  const groups = useMemo(() => {
    // 往前留 7 天：Outlook 里的会议常常是已发生的，只显示未来会导致
    // "明明同步了却什么都没看到"
    const from = addDays(dayStart(Date.now()), -LOOKBACK);
    const to = addDays(from, HORIZON + LOOKBACK);
    const rows: Row[] = [];

    for (const ev of snapshot.events) {
      // colorKey 本该来自 calendar_source（灰阶档位），移动端没把源解析进 snapshot，
      // 先统一 0；后续做"日历源开关"时再接上
      const origin = { sourceId: ev.sourceId, webLink: ev.webLink, readOnly: true, colorKey: 0 };
      if (ev.rrule) {
        // 重复事件必须展开成实例：只显示母体的话，"每周一开会"在日历上
        // 只出现一次，看起来像一条数据而不是 N 次安排
        const occurrences: Occurrence[] = expandSeries(
          {
            id: ev.id,
            title: ev.subject,
            startAt: ev.startAt,
            endAt: ev.endAt,
            allDay: ev.allDay,
            rrule: ev.rrule,
            // 例外必须带上：否则在 Outlook 里删掉的那一次还会显示出来
            exceptions: snapshot.exceptions.filter((x) => x.seriesId === ev.id),
            kind: 'event',
            origin,
          },
          from,
          to,
          200,
        );
        for (const occ of occurrences) {
          rows.push({
            key: `${ev.id}@${occ.originalStart}`,
            start: occ.start,
            end: occ.end,
            allDay: occ.allDay,
            title: occ.title,
            location: ev.location,
            kind: 'event',
            webLink: ev.webLink,
            taskId: null,
          });
        }
      } else if (ev.startAt >= from && ev.startAt < to) {
        rows.push({
          key: ev.id,
          start: ev.startAt,
          end: ev.endAt,
          allDay: ev.allDay,
          title: ev.subject,
          location: ev.location,
          kind: 'event',
          webLink: ev.webLink,
          taskId: null,
        });
      }
    }

    for (const task of snapshot.tasks) {
      if (task.completedAt !== null) continue;
      const hasTime = task.startAt !== null;
      const dueTs = task.dueDate ? new Date(`${task.dueDate}T09:00:00`).getTime() : null;
      const start = task.startAt ?? dueTs;
      if (start === null || start < from || start >= to) continue;
      rows.push({
        key: task.id,
        start,
        end: task.endAt ?? start + 30 * 60_000,
        allDay: !hasTime,
        title: task.title,
        location: task.location,
        kind: 'task',
        webLink: null,
        taskId: task.id,
      });
    }

    rows.sort((a, b) => a.start - b.start);

    const index = new Map<number, Row[]>();
    for (const row of rows) {
      const day = dayStart(row.start);
      const bucket = index.get(day) ?? [];
      bucket.push(row);
      index.set(day, bucket);
    }
    return [...index.entries()].sort((a, b) => a[0] - b[0]).map(([day, list]) => ({ day, list }));
  }, [snapshot.events, snapshot.tasks, snapshot.exceptions]);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.head}>
        <Text style={styles.title}>日历</Text>
        <Text style={styles.sub}>
          近 {LOOKBACK} 天到未来 {HORIZON} 天 · 共 {snapshot.events.length} 个 Outlook 事件
        </Text>
      </View>

      <FlatList
        data={groups}
        keyExtractor={(group) => String(group.day)}
        contentContainerStyle={groups.length === 0 ? styles.emptyWrap : styles.list}
        ListEmptyComponent={
          <View>
            <Text style={styles.emptyTitle}>这段时间没有安排</Text>
            <Text style={styles.emptyHint}>
              {snapshot.events.length === 0
                ? '本机还没有任何 Outlook 事件。Outlook 是在网页版「设置 · 日历」里连接的，手机端只负责同步下来 —— 先去网页版确认能看到日历，再回「设置」点「立即同步」。'
                : `本机有 ${snapshot.events.length} 个 Outlook 事件，但都不在这个时间窗口内。`}
            </Text>
          </View>
        }
        renderItem={({ item: group }) => {
          const d = new Date(group.day);
          return (
            <View>
              <View style={styles.dateHead}>
                <Text style={styles.dateText}>
                  {d.getMonth() + 1} 月 {d.getDate()} 日
                  <Text style={styles.dateWeek}>  周{WEEK[d.getDay()]}</Text>
                </Text>
              </View>
              {group.list.map((row) => (
                <RowItem key={row.key} row={row} />
              ))}
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}

function RowItem({ row }: { row: Row }) {
  return (
    <View style={styles.row}>
      <Text style={styles.time}>{row.allDay ? '全天' : clock(row.start)}</Text>

      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {row.title}
        </Text>
        {row.location ? (
          <Text style={styles.rowLoc} numberOfLines={1}>
            {row.location}
          </Text>
        ) : null}
        <Text style={styles.rowMeta}>{row.kind === 'event' ? 'Outlook · 只读' : '待办'}</Text>
      </View>

      {row.webLink ? (
        <Pressable
          onPress={() => {
            if (row.webLink) void Linking.openURL(row.webLink);
          }}
          style={styles.openBtn}
          accessibilityRole="button"
          accessibilityLabel="在 Outlook 中打开这条事件"
        >
          <Text style={styles.openText}>在 Outlook 中打开</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.n0 },
  head: { paddingHorizontal: SP[4], paddingTop: SP[4], paddingBottom: SP[3] },
  title: { fontSize: FONT.xl, color: C.n900, fontWeight: '600' },
  sub: { marginTop: SP[1], fontSize: FONT.base, color: C.n500 },
  list: { paddingHorizontal: SP[4], paddingBottom: SP[8] },
  emptyWrap: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: SP[4] },
  emptyTitle: { fontSize: FONT.md, color: C.n700 },
  emptyHint: { marginTop: SP[2], fontSize: FONT.base, color: C.n500, lineHeight: 21 },
  dateHead: {
    paddingTop: SP[4],
    paddingBottom: SP[1],
    borderBottomWidth: 1,
    borderBottomColor: C.n200,
  },
  dateText: { fontSize: FONT.body, color: C.n900, fontWeight: '600' },
  dateWeek: { fontSize: FONT.sm, color: C.n500, fontWeight: '400' },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SP[3],
    paddingVertical: SP[3],
    borderBottomWidth: 1,
    borderBottomColor: C.n100,
  },
  time: {
    width: 48,
    paddingTop: 2,
    fontSize: FONT.sm,
    color: C.n500,
    fontVariant: ['tabular-nums'],
  },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: FONT.body, color: C.n900, lineHeight: 21 },
  rowLoc: { marginTop: 2, fontSize: FONT.sm, color: C.n500 },
  rowMeta: { marginTop: 4, fontSize: FONT.xs, color: C.n400 },
  openBtn: {
    minHeight: HIT - 8,
    paddingHorizontal: SP[2],
    justifyContent: 'center',
  },
  openText: { fontSize: FONT.xs, color: C.a500 },
});
