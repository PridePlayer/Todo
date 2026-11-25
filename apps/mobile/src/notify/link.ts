import * as Notifications from 'expo-notifications';
import { router, type Href } from 'expo-router';

/**
 * 点通知之后去哪。
 *
 * 两个入口都要接，缺一个就有一种"点了没反应"：
 *   1. App 在前台/后台时点通知 → addNotificationResponseReceivedListener
 *   2. App 已经被系统杀掉、点通知把它拉起来 → getLastNotificationResponseAsync
 *
 * 第 2 条是最容易被漏的，而它恰好是最常见的场景：早上手机锁屏，点通知，
 * App 冷启动 —— 这时候没有任何监听器在工作，只能靠"上一次的响应"补回来。
 */

function routeFor(data: unknown): Href | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const id = typeof record.id === 'string' && record.id !== '' ? record.id : null;
  if (!id) return null;
  if (record.kind === 'task') return `/task/${id}` as Href;
  if (record.kind === 'habit') return `/habit/${id}` as Href;
  return null;
}

function navigate(data: unknown, delayMs: number): void {
  const href = routeFor(data);
  if (!href) return;
  // 冷启动时 router 可能还没挂载完，直接 push 会被丢掉（表现就是"点了通知，App 开了但停在首页"）
  if (delayMs > 0) setTimeout(() => router.push(href), delayMs);
  else router.push(href);
}

/** 挂上两个入口，返回清理函数 */
export function attachNotificationRouting(): () => void {
  void Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (response) navigate(response.notification.request.content.data, 600);
    })
    .catch(() => undefined);

  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    navigate(response.notification.request.content.data, 0);
  });

  return () => subscription.remove();
}
