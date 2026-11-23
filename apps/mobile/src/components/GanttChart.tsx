import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { C, FONT, SP } from '../theme';

/**
 * 手机版甘特。
 *
 * 不做横向滚动的时间轴：横向滚动 + 长列表在手机上会互相打架
 * （往左滚看时间、往下滚看任务，两根手指），而且一条任务往往跨好几天，
 * 滚动窗口里只剩半截条形。
 *
 * 这里改成"窗口等分到屏幕宽度"：切日/周/月只是改变时间跨度，
 * 条形按百分比定位，一屏看全。语义与 Web 端一致，交互按手机重做。
 */

type Zoom = 'day' | 'week' | 'month';

const ZOOM_META: Record<Zoom, { label: string; days: number; back: number }> = {
  day: { label: '日', days: 14, back: 3 },
  week: { label: '周', days: 84, back: 14 },
  month: { label: '月', days: 180, back: 30 },
};

const DAY = 86_400_000;

function addDays(ts: number, n: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export interface GanttItem {
  id: string;
  title: string;
  start: number | null;
  end: number | null;
  done: boolean;
  groupName: string;
}

export function GanttChart({ items, onOpen }: { items: GanttItem[]; onOpen: (id: string) => void }) {
  const [zoom, setZoom] = useState<Zoom>('day');
  const [offset, setOffset] = useState(0);

  const winStart = useMemo(() => {
    const meta = ZOOM_META[zoom];
    return addDays(addDays(Date.now(), -meta.back), offset * meta.days);
  }, [zoom, offset]);
  const winEnd = addDays(winStart, ZOOM_META[zoom].days);

  const ticks = useMemo(() => {
    const count = 6;
    const step = ZOOM_META[zoom].days / count;
    return Array.from({ length: count }, (_, i) => {
      const d = new Date(addDays(winStart, Math.round(i * step)));
      return { label: `${d.getMonth() + 1}/${d.getDate()}`, key: i };
    });
  }, [zoom, winStart]);

  const groups = useMemo(() => {
    const map = new Map<string, GanttItem[]>();
    const unscheduled: GanttItem[] = [];
    for (const item of items) {
      if (item.start === null) {
        unscheduled.push(item);
        continue;
      }
      const bucket = map.get(item.groupName) ?? [];
      bucket.push(item);
      map.set(item.groupName, bucket);
    }
    const out = [...map.entries()].map(([name, list]) => ({
      name,
      list: list.sort((a, b) => (a.start ?? 0) - (b.start ?? 0)),
    }));
    if (unscheduled.length > 0) out.push({ name: '未排期', list: unscheduled });
    return out;
  }, [items]);

  return (
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <View style={styles.segments}>
          {(['day', 'week', 'month'] as Zoom[]).map((z) => (
            <Pressable
              key={z}
              onPress={() => {
                setZoom(z);
                setOffset(0);
              }}
              style={[styles.seg, zoom === z && styles.segOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: zoom === z }}
            >
              <Text style={[styles.segText, zoom === z && styles.onText]}>{ZOOM_META[z].label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.segments}>
          <Pressable onPress={() => setOffset((o) => o - 1)} style={styles.seg} accessibilityRole="button" accessibilityLabel="上一段">
            <Text style={styles.segText}>&#8592;</Text>
          </Pressable>
          <Pressable onPress={() => setOffset(0)} style={styles.seg} accessibilityRole="button" accessibilityLabel="回到今天">
            <Text style={styles.segText}>今天</Text>
          </Pressable>
          <Pressable onPress={() => setOffset((o) => o + 1)} style={styles.seg} accessibilityRole="button" accessibilityLabel="下一段">
            <Text style={styles.segText}>&#8594;</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.scaleRow}>
        <View style={styles.nameSpacer} />
        <View style={styles.scaleTrack}>
          {ticks.map((t) => (
            <Text key={t.key} style={styles.scaleLabel}>
              {t.label}
            </Text>
          ))}
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {groups.length === 0 ? (
          <Text style={styles.empty}>还没有带日期的待办</Text>
        ) : (
          groups.map((group) => (
            <View key={group.name}>
              <Text style={styles.groupName}>
                {group.name}
                <Text style={styles.groupCount}>  {group.list.length}</Text>
              </Text>

              {group.list.map((item) => {
                const span = winEnd - winStart;
                const startPct =
                  item.start === null ? 0 : Math.min(1, Math.max(0, (item.start - winStart) / span));
                const endPct =
                  item.end === null || item.start === null
                    ? Math.min(1, startPct + 0.08)
                    : Math.min(1, Math.max(startPct + 0.02, (item.end - winStart) / span));
                const outside = item.start !== null && (item.start < winStart || item.start > winEnd);

                return (
                  <Pressable
                    key={item.id}
                    onPress={() => onOpen(item.id)}
                    style={styles.row}
                    accessibilityRole="button"
                    accessibilityLabel={`打开「${item.title}」`}
                  >
                    <Text style={styles.name} numberOfLines={2}>
                      {item.title}
                    </Text>
                    <View style={styles.track}>
                      {item.start === null ? (
                        <Text style={styles.unscheduled}>未排期</Text>
                      ) : (
                        <View
                          style={[
                            styles.bar,
                            item.done && styles.barDone,
                            outside && styles.barOutside,
                            {
                              left: `${startPct * 100}%`,
                              width: `${Math.max(6, (endPct - startPct) * 100)}%`,
                            },
                          ]}
                        />
                      )}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: SP[4],
    paddingBottom: SP[2],
    gap: SP[2],
  },
  segments: { flexDirection: 'row', gap: 1, backgroundColor: C.n200, borderWidth: 1, borderColor: C.n200 },
  seg: {
    height: 28,
    paddingHorizontal: SP[3],
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.n0,
  },
  segOn: { backgroundColor: C.n900 },
  segText: { fontSize: FONT.sm, color: C.n600 },
  onText: { color: C.n0 },
  scaleRow: { flexDirection: 'row', paddingHorizontal: SP[4], paddingBottom: SP[1] },
  nameSpacer: { width: 120 },
  scaleTrack: { flex: 1, flexDirection: 'row', justifyContent: 'space-between' },
  scaleLabel: { fontSize: FONT.xs, color: C.n500, fontVariant: ['tabular-nums'] },
  body: { paddingHorizontal: SP[4], paddingBottom: SP[8] },
  groupName: {
    marginTop: SP[3],
    marginBottom: SP[1],
    fontSize: FONT.sm,
    color: C.n700,
    fontWeight: '600',
  },
  groupCount: { fontSize: FONT.xs, color: C.n400, fontWeight: '400' },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 38 },
  name: { width: 120, paddingRight: SP[2], fontSize: FONT.sm, color: C.n700, lineHeight: 17 },
  track: {
    flex: 1,
    height: 22,
    justifyContent: 'center',
    backgroundColor: C.n50,
    borderRadius: 2,
    overflow: 'hidden',
  },
  bar: {
    position: 'absolute',
    height: 14,
    borderRadius: 2,
    backgroundColor: C.a100,
    borderWidth: 1,
    borderColor: C.a500,
  },
  barDone: { backgroundColor: C.n100, borderColor: C.n300 },
  barOutside: { opacity: 0.35 },
  unscheduled: { fontSize: FONT.xs, color: C.n400, paddingLeft: SP[2] },
  empty: { padding: SP[6], fontSize: FONT.body, color: C.n500 },
});
