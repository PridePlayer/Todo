// Metro 的入口。
//
// 必须在 App 启动之外再注册一次 headless 任务：桌面小组件被 launcher 唤醒时，
// 走的是 `RNWidgetBackgroundTask` 这条 Headless JS 通道，它不经过 expo-router 的入口，
// 但没有注册就没人接活 —— 症状是"widget 加到桌面上是一片空白，点也没反应"。
import { registerWidgetTaskHandler } from 'react-native-android-widget';
import { widgetTaskHandler } from './src/widget/task-handler';
import 'expo-router/entry';

registerWidgetTaskHandler(widgetTaskHandler);
