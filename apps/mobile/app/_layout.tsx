// 必须是第一行 import：补 crypto.getRandomValues，且要在任何 ulid() 之前执行
import '../src/polyfill';

import * as Notifications from 'expo-notifications';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { attachNotificationRouting } from '../src/notify/link';
import { AppProvider } from '../src/store';

/**
 * App 在前台时收到通知也要显示。
 *
 * 默认行为是"前台不弹"（因为系统认为你正在看这个 App）。但提醒的意义就是
 * "在你不看的时候叫你"，而用户很可能正开着 App 在别的页面 —— 静默吞掉等于没提醒。
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function RootLayout() {
  useEffect(() => attachNotificationRouting(), []);

  return (
    <AppProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="login" options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="task/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="habit/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="settings" options={{ headerShown: true, title: '设置' }} />
      </Stack>
    </AppProvider>
  );
}
