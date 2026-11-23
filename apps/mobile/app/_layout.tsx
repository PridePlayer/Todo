// 必须是第一行 import：补 crypto.getRandomValues，且要在任何 ulid() 之前执行
import '../src/polyfill';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppProvider } from '../src/store';

export default function RootLayout() {
  return (
    <AppProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="login" options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="task/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="settings" options={{ headerShown: true, title: '设置' }} />
      </Stack>
    </AppProvider>
  );
}
