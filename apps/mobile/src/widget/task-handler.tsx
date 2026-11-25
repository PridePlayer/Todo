import type { WidgetTaskHandler } from 'react-native-android-widget';
import { loadAuth } from '../auth';
import { flushOutbox } from '../sync/push';
import { GridWidget, GridWidgetSignedOut } from './GridWidget';
import { checkHabitFromWidget, loadWidgetSummary, toggleTaskFromWidget } from './data';
import { WIDGET_NAME } from './widget-name';

/**
 * 小组件的 headless 任务（docs/11）。
 *
 * 它在**没有 UI 的 JS 上下文**里运行：不能 use hook、不能碰 App 的 Context，
 * 也没有"用户点了之后给个 toast"这种反馈通道 —— 唯一能做的反馈就是重绘这块 widget。
 * 所以每一次点击处理完毕都必须调用 renderWidget()，哪怕结果是"什么都没变"。
 *
 * 四个 action 的含义：
 *   WIDGET_ADDED / WIDGET_UPDATE / WIDGET_RESIZED —— 拉数据并画
 *   WIDGET_CLICK —— 先本地改（乐观），立刻重绘，然后在后台推
 *   WIDGET_DELETED —— 用户把 widget 从桌面删了，不做任何事
 */
export const widgetTaskHandler: WidgetTaskHandler = async ({
  widgetInfo,
  widgetAction,
  clickAction,
  clickActionData,
  renderWidget,
}) => {
  // 将来可能加第二个 widget（比如纯日历），先按名字分流，避免改错别人的画面
  if (widgetInfo.widgetName !== WIDGET_NAME) return;
  if (widgetAction === 'WIDGET_DELETED') return;

  // ── 点击：先改本地、立刻重绘，再后台推 ──────────────────
  if (widgetAction === 'WIDGET_CLICK') {
    const data = (clickActionData ?? {}) as Record<string, unknown>;

    try {
      if (clickAction === 'TOGGLE_TASK') {
        const taskId = typeof data.taskId === 'string' ? data.taskId : '';
        if (taskId) {
          const next = await toggleTaskFromWidget(taskId);
          if (next) {
            // 先画：用户看到的是"这条消失了，下一条补上来"，不必等网络
            renderWidget(<GridWidget summary={next} />);
            void pushInBackground();
            return;
          }
        }
      } else if (clickAction === 'CHECK_HABIT') {
        const habitId = typeof data.habitId === 'string' ? data.habitId : '';
        if (habitId) {
          const next = await checkHabitFromWidget(habitId);
          if (next) {
            renderWidget(<GridWidget summary={next} />);
            void pushInBackground();
            return;
          }
        }
      }
      // 走到这里说明本地没有那条数据（比如 App 刚清过缓存）：
      // 退回去做一次完整刷新，比让点击静默失败好
    } catch (error) {
      console.warn('[widget] click failed', error);
    }
  }

  // ── 拉数据并画 ──────────────────────────────────────────
  const { summary, reason } = await loadWidgetSummary();

  if (!summary) {
    renderWidget(reason === 'no-token' || reason === 'expired' ? <GridWidgetSignedOut /> : <GridWidget summary={null} />);
    return;
  }

  renderWidget(<GridWidget summary={summary} />);
};

/**
 * 后台推送。
 *
 * 写入用的是**主令牌**（sync/push 不在 widget 令牌的权限内）。
 * 主令牌在 SecureStore 里，headless 读得到就推、读不到就留在 outbox ——
 * 那条改动不会丢，用户下次打开 App 时 refresh 会把它推上去。
 * 这正是"离线可用"这条底线该有的表现，不是降级。
 */
async function pushInBackground(): Promise<void> {
  try {
    const auth = await loadAuth();
    if (!auth?.token) return;
    await flushOutbox({ token: auth.token });
  } catch (error) {
    // 网络不通时静默：outbox 里的东西还在，下次再推
    console.warn('[widget] push failed', error);
  }
}
