import { QUADRANT_META, QUADRANT_ORDER, type Quadrant } from '@grid/core';
import { useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../../src/store';
import { C, FONT, HIT, SP } from '../../src/theme';

/**
 * 四象限。
 *
 * 手机上不做拖拽 —— 2×2 网格里每格只有半屏宽，长按拖动会和滚动打架，
 * 而且第一版只要求"看得清、能完成"。迁移象限留在 Web 端。
 */
export default function QuadrantScreen() {
  const { snapshot, toggleTask } = useApp();

  const groups = useMemo(() => {
    const map = new Map<Quadrant, typeof snapshot.tasks>();
    for (const q of QUADRANT_ORDER) map.set(q, []);
    for (const task of snapshot.tasks) {
      if (task.completedAt !== null) continue;
      map.get(task.quadrant)?.push(task);
    }
    for (const list of map.values()) list.sort((a, b) => a.sortOrder - b.sortOrder);
    return map;
  }, [snapshot.tasks]);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.head}>
        <Text style={styles.title}>四象限</Text>
        <Text style={styles.sub}>按重要 × 紧急分成四格，每格按手动顺序排列</Text>
      </View>

      <FlatList
        data={QUADRANT_ORDER}
        keyExtractor={(q) => String(q)}
        numColumns={2}
        columnWrapperStyle={styles.rowWrap}
        contentContainerStyle={styles.grid}
        renderItem={({ item: q }) => {
          const meta = QUADRANT_META[q];
          const tasks = groups.get(q) ?? [];
          return (
            <View style={styles.cell}>
              <View style={styles.cellHead}>
                <Text style={styles.cellNo}>{meta.no}</Text>
                <Text style={styles.cellTitle}>{meta.title}</Text>
                <Text style={styles.cellCount}>{tasks.length}</Text>
              </View>
              <View style={styles.cellBody}>
                {tasks.length === 0 ? (
                  <Text style={styles.cellEmpty}>空</Text>
                ) : (
                  tasks.slice(0, 8).map((task) => (
                    <Pressable
                      key={task.id}
                      onPress={() => void toggleTask(task.id)}
                      style={({ pressed }) => [styles.item, pressed && { opacity: 0.6 }]}
                      accessibilityRole="button"
                      accessibilityLabel={`完成「${task.title}」`}
                    >
                      <Text style={styles.itemText} numberOfLines={2}>
                        {task.title}
                      </Text>
                    </Pressable>
                  ))
                )}
                {tasks.length > 8 ? <Text style={styles.more}>还有 {tasks.length - 8} 项</Text> : null}
              </View>
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.n0 },
  head: { paddingHorizontal: SP[4], paddingTop: SP[4], paddingBottom: SP[3] },
  title: { fontSize: FONT.xl, color: C.n900, fontWeight: '600' },
  sub: { marginTop: SP[1], fontSize: FONT.base, color: C.n500 },
  grid: { paddingHorizontal: SP[3], paddingBottom: SP[8] },
  rowWrap: { gap: SP[2] },
  cell: {
    flex: 1,
    borderWidth: 1,
    borderColor: C.n200,
    borderRadius: 2,
    minHeight: 160,
    marginBottom: SP[2],
    backgroundColor: C.n0,
  },
  cellHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingHorizontal: SP[3],
    paddingTop: SP[3],
    paddingBottom: SP[2],
    borderBottomWidth: 1,
    borderBottomColor: C.n200,
  },
  cellNo: { fontSize: FONT.xs, color: C.n400, fontVariant: ['tabular-nums'] },
  cellTitle: { flex: 1, marginLeft: SP[2], fontSize: FONT.base, color: C.n900, fontWeight: '600' },
  cellCount: { fontSize: FONT.sm, color: C.n500, fontVariant: ['tabular-nums'] },
  cellBody: { paddingHorizontal: SP[2], paddingVertical: SP[2] },
  cellEmpty: { fontSize: FONT.sm, color: C.n400, paddingHorizontal: SP[1], paddingVertical: SP[1] },
  item: { minHeight: HIT - 12, justifyContent: 'center', paddingHorizontal: SP[1], paddingVertical: SP[1] },
  itemText: { fontSize: FONT.base, color: C.n700, lineHeight: 18 },
  more: { marginTop: SP[1], paddingHorizontal: SP[1], fontSize: FONT.xs, color: C.n500 },
});
