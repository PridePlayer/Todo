import { QUADRANT_META, QUADRANT_ORDER, type Quadrant, type Task } from '@grid/core';
import { useMemo } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';
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
  const { snapshot, toggleTask, patchTask } = useApp();
  // 长按迁移象限：手机上做不了跨格拖拽，用长按选目标格替代
  const [moving, setMoving] = useState<Task | null>(null);

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
                      onLongPress={() => setMoving(task)}
                      delayLongPress={350}
                      style={({ pressed }) => [styles.item, pressed && { opacity: 0.6 }]}
                      accessibilityRole="button"
                      accessibilityLabel={`完成「${task.title}」，长按可移动到其他象限`}
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
      <Modal visible={moving !== null} transparent animationType="fade" onRequestClose={() => setMoving(null)}>
        <Pressable style={styles.backdrop} onPress={() => setMoving(null)} accessibilityLabel="关闭" />
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>移动到</Text>
          {QUADRANT_ORDER.map((q) => {
            const meta = QUADRANT_META[q];
            const current = moving?.quadrant === q;
            return (
              <Pressable
                key={q}
                disabled={current}
                onPress={() => {
                  const task = moving;
                  if (!task) return;
                  setMoving(null);
                  if (current) return;
                  const bits = 4 - q;
                  // 只传两个开关，quadrant 由 patchTask 派生
                  void patchTask(task.id, { important: (bits & 2) !== 0, urgent: (bits & 1) !== 0 });
                }}
                style={[styles.moveRow, current && styles.moveRowCurrent]}
                accessibilityRole="button"
              >
                <Text style={[styles.moveNo, current && { color: C.n400 }]}>{meta.no}</Text>
                <Text style={[styles.moveTitle, current && { color: C.n400 }]}>{meta.title}</Text>
                {current ? <Text style={styles.moveCurrent}>当前</Text> : null}
              </Pressable>
            );
          })}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(10,10,10,0.28)' },
  sheet: {
    position: 'absolute',
    left: SP[4],
    right: SP[4],
    top: '32%',
    backgroundColor: C.n0,
    borderWidth: 1,
    borderColor: C.n200,
    borderRadius: 2,
    padding: SP[3],
  },
  sheetTitle: { fontSize: FONT.xs, color: C.n500, marginBottom: SP[2] },
  moveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP[2],
    minHeight: HIT,
    paddingHorizontal: SP[2],
    borderBottomWidth: 1,
    borderBottomColor: C.n100,
  },
  moveRowCurrent: { opacity: 0.6 },
  moveNo: { fontSize: FONT.xs, color: C.n400, width: 24 },
  moveTitle: { flex: 1, fontSize: FONT.body, color: C.n900 },
  moveCurrent: { fontSize: FONT.xs, color: C.n400 },
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
