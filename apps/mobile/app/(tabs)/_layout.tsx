import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Fab } from '../../src/components/Fab';
import { useApp } from '../../src/store';
import { C, FONT } from '../../src/theme';

/** 每个页签一个语义图标。全部用 outline 系列，粗细才一致 */
const TAB_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  index: 'today-outline',
  list: 'list-outline',
  calendar: 'calendar-outline',
  quadrant: 'grid-outline',
  habits: 'checkmark-circle-outline',
};

const TAB_TITLE: Record<string, string> = {
  index: '今日',
  list: '列表',
  calendar: '日历',
  quadrant: '四象限',
  habits: '打卡',
};

const styles = StyleSheet.create({
  flash: {
    position: 'absolute',
    left: 16,
    right: 16,
    // 浮在 tab 栏之上，又不挡内容
    bottom: 96,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 2,
    backgroundColor: C.n900,
  },
  flashText: { color: C.n0, fontSize: FONT.sm, textAlign: 'center' },
});

export default function TabsLayout() {
  const { ready, auth, flash } = useApp();
  // Android 手势导航条会盖住 tab 文字、吃掉可点区域，必须留出高度
  const insets = useSafeAreaInsets();

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
    <View style={{ flex: 1 }}>
    <Tabs
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: C.a500,
        tabBarInactiveTintColor: C.n400,
        tabBarStyle: {
          backgroundColor: C.n0,
          borderTopColor: C.n200,
          borderTopWidth: 1,
          // 56 是内容高度，insets.bottom 是手势条，两者相加 tab 才完整露出来
          height: 56 + insets.bottom,
          paddingBottom: 6 + insets.bottom,
          paddingTop: 6,
        },
        tabBarLabelStyle: { fontSize: FONT.xs },
        tabBarIcon: ({ color, size }) => (
          // RN 的 tabBarIcon 传下来的 color 类型是 ColorValue，Ionicons 的参数是 string。
          // 两者实际同物（都是颜色字符串），只是类型定义各写各的
          <Ionicons name={TAB_ICON[route.name] ?? 'ellipse-outline'} size={size} color={color as string} />
        ),
      })}
    >
      {(['index', 'list', 'calendar', 'quadrant', 'habits'] as const).map((name) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{
            title: TAB_TITLE[name],
            tabBarLabel: ({ color }) => (
              <Text style={{ color, fontSize: FONT.xs }}>{TAB_TITLE[name]}</Text>
            ),
          }}
        />
      ))}
    </Tabs>
      <Fab />
      {flash ? (
        <View style={styles.flash} pointerEvents="none">
          <Text style={styles.flashText}>{flash}</Text>
        </View>
      ) : null}
    </View>
  );
}
