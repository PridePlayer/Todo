import { buildWidgetSummary, type Habit, type HabitLog, type Task } from '@grid/core';
import { Platform } from 'react-native';
import { localDayRange } from '../domain/today';
import { GridWidget } from './GridWidget';
import { WIDGET_NAME } from './widget-name';
import { writeCachedSummary } from './data';

/**
 * App 内改完数据后，把桌面刷成最新的。
 *
 * 为什么需要这一步：`updatePeriodMillis` 的下限是 30 分钟。如果不在 App 内主动推，
 * 用户在 App 里勾掉一条待办，切回桌面看到的还是旧的 —— 而"我刚做完的它还挂着"
 * 是最容易被当成 bug 的现象。
 *
 * 用本地 snapshot 算 summary（而不是再打一次接口）：
 *   · 省一次请求
 *   · 算法与接口共用一个 core 函数，数字不会不一致
 *   · 离线时也能刷（本地数据本来就在）
 */

export interface WidgetSourceData {
  tasks: Task[];
  habits: Habit[];
  logs: HabitLog[];
}

/** 3 秒内不重复推：refresh 会在一次操作里连发多次 reload，不去重就是几十次原生调用 */
let lastPushAt = 0;

export async function publishWidgetToHomeScreen(data: WidgetSourceData): Promise<void> {
  if (Platform.OS !== 'android') return;
  const now = Date.now();
  if (now - lastPushAt < 3000) return;
  lastPushAt = now;

  try {
    const { today, dayStart, dayEnd } = localDayRange();
    const summary = buildWidgetSummary({
      tasks: data.tasks,
      habits: data.habits,
      logs: data.logs,
      today,
      dayStart,
      dayEnd,
      now,
    });
    // 先写缓存：即使下面原生调用失败（比如桌面上还没加 widget），
    // widget 下次醒来也能拿到这份最新的
    await writeCachedSummary(summary);

    // 动态 import：Expo Go 里没有这个原生模块，静态 import 会在启动时直接崩
    const { requestWidgetUpdate } = await import('react-native-android-widget');
    await requestWidgetUpdate({
      widgetName: WIDGET_NAME,
      renderWidget: () => <GridWidget summary={summary} />,
      widgetNotFound: () => {
        // 桌面上没加这个 widget：正常情况，不是错误
      },
    });
  } catch (error) {
    console.warn('[widget] publish skipped', error);
  }
}
