import { useCallback, useEffect, useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { C, FONT, HIT, SP } from '../theme';
import { currentPermission, ensurePermission, type NotificationPermission } from './schedule';

/**
 * 三步权限引导（PRD 05 · M6 验收第 5 条）。
 *
 * 为什么三步而不是一步：三个开关在三个不同的地方，而且没有一个能用 JS 直接打开 ——
 * 「精确闹钟」和「电池白名单」在 Android 上都是特殊权限，只能跳系统设置页让用户自己点。
 * 所以能做的只有"说清楚要做哪三件事，并把人送到门口"。
 *
 * 三步全部可跳过：用户拒绝通知，App 其余功能照常。把提醒做成硬门禁是另一种绑架。
 */

export interface PermissionGuideProps {
  visible: boolean;
  onClose: () => void;
}

interface StepProps {
  index: number;
  title: string;
  detail: string;
  done: boolean | null;
  actionLabel: string;
  onPress: () => void;
}

function Step({ index, title, detail, done, actionLabel, onPress }: StepProps) {
  return (
    <View style={styles.step}>
      <View style={[styles.badge, done === true && styles.badgeDone]}>
        <Text style={[styles.badgeText, done === true && styles.badgeTextDone]}>{index}</Text>
      </View>
      <View style={styles.stepBody}>
        <Text style={styles.stepTitle}>{title}</Text>
        <Text style={styles.stepDetail}>{detail}</Text>
      </View>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.stepAction, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`${title}：${actionLabel}`}
      >
        <Text style={styles.stepActionText}>{done === true ? '已完成' : actionLabel}</Text>
      </Pressable>
    </View>
  );
}

export function PermissionGuide({ visible, onClose }: PermissionGuideProps) {
  const [permission, setPermission] = useState<NotificationPermission>('undetermined');

  const refresh = useCallback(() => {
    void currentPermission().then(setPermission);
  }, []);

  useEffect(() => {
    if (visible) refresh();
  }, [visible, refresh]);

  const askNotification = useCallback(async () => {
    const next = await ensurePermission();
    setPermission(next);
  }, []);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>让提醒准时响</Text>
          <Text style={styles.lead}>
            提醒是纯本地的，不经过服务器。下面三件事决定了它能不能把你叫醒 ——
            国内定制系统尤其容易在第二、三条上把后台掐掉。
          </Text>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            <Step
              index={1}
              title="允许通知"
              detail="没有这条，提醒会排程成功但不会显示。"
              done={permission === 'granted'}
              actionLabel={permission === 'denied' ? '去设置' : '允许'}
              onPress={() => {
                if (permission === 'denied') void Linking.openSettings();
                else void askNotification();
              }}
            />
            <Step
              index={2}
              title="允许精确闹钟"
              detail="Android 12 起，省电模式会把闹钟推迟到最接近的维护窗口 —— 可能晚十几分钟。在「设置 → 应用 → GRID → 闹钟和提醒」里允许。"
              done={null}
              actionLabel="打开设置"
              onPress={() => void Linking.openSettings()}
            />
            <Step
              index={3}
              title="加入电池白名单"
              detail="小米 / 华为 / OPPO / vivo 会在熄屏后冻结后台应用，提醒就再也不触发。在应用设置里把「省电策略」改成「无限制」。"
              done={null}
              actionLabel="打开设置"
              onPress={() => void Linking.openSettings()}
            />
          </ScrollView>

          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
            accessibilityRole="button"
          >
            <Text style={styles.primaryText}>知道了</Text>
          </Pressable>
          <Text style={styles.footnote}>这三步随时可以从系统设置里改回来，不影响其他功能。</Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(24, 24, 27, 0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: C.n0,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: SP[4],
    paddingTop: SP[6],
    paddingBottom: SP[8],
    maxHeight: '86%',
  },
  title: {
    fontSize: FONT.md,
    fontWeight: '600',
    color: C.n900,
    marginBottom: SP[2],
  },
  lead: {
    fontSize: FONT.sm,
    color: C.n600,
    lineHeight: 19,
    marginBottom: SP[4],
  },
  list: { maxHeight: 380 },
  listContent: { gap: SP[3] },
  step: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SP[3],
    paddingVertical: SP[2],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.n200,
  },
  badge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: C.n300,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  badgeDone: { backgroundColor: C.a500, borderColor: C.a500 },
  badgeText: { fontSize: FONT.xs, color: C.n500, fontWeight: '600' },
  badgeTextDone: { color: C.n0 },
  stepBody: { flex: 1, gap: 2 },
  stepTitle: { fontSize: FONT.base, color: C.n900, fontWeight: '500' },
  stepDetail: { fontSize: FONT.sm, color: C.n500, lineHeight: 18 },
  stepAction: {
    minHeight: 32,
    paddingHorizontal: SP[3],
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.a200,
    backgroundColor: C.a100,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  stepActionText: { fontSize: FONT.sm, color: C.a500, fontWeight: '500' },
  primary: {
    marginTop: SP[4],
    height: HIT,
    borderRadius: 10,
    backgroundColor: C.a500,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: C.n0, fontSize: FONT.body, fontWeight: '600' },
  footnote: {
    fontSize: FONT.xs,
    color: C.n400,
    textAlign: 'center',
    marginTop: SP[3],
  },
  pressed: { opacity: 0.72 },
});
