import { Redirect, Tabs } from 'expo-router';
import { ActivityIndicator, Text, View } from 'react-native';
import { useApp } from '../../src/store';
import { C, FONT } from '../../src/theme';

export default function TabsLayout() {
  const { ready, auth } = useApp();

  // 首帧还没读完 SecureStore 时不能直接跳登录页：
  // 那样每次冷启动都会闪一下登录界面再跳回来
  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.n0 }}>
        <ActivityIndicator color={C.a500} />
      </View>
    );
  }

  if (!auth) return <Redirect href="/login" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: C.a500,
        tabBarInactiveTintColor: C.n500,
        tabBarStyle: {
          backgroundColor: C.n0,
          borderTopColor: C.n200,
          borderTopWidth: 1,
          height: 56,
          paddingBottom: 6,
          paddingTop: 6,
        },
        tabBarLabelStyle: { fontSize: FONT.xs },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: '今日', tabBarLabel: ({ color }) => <Text style={{ color, fontSize: FONT.xs }}>今日</Text> }}
      />
      <Tabs.Screen
        name="list"
        options={{ title: '列表', tabBarLabel: ({ color }) => <Text style={{ color, fontSize: FONT.xs }}>列表</Text> }}
      />
      <Tabs.Screen
        name="quadrant"
        options={{ title: '四象限', tabBarLabel: ({ color }) => <Text style={{ color, fontSize: FONT.xs }}>四象限</Text> }}
      />
      <Tabs.Screen
        name="habits"
        options={{ title: '打卡', tabBarLabel: ({ color }) => <Text style={{ color, fontSize: FONT.xs }}>打卡</Text> }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: '设置', tabBarLabel: ({ color }) => <Text style={{ color, fontSize: FONT.xs }}>设置</Text> }}
      />
    </Tabs>
  );
}
