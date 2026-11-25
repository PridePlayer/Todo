/**
 * 与 app.json 里 `plugins → react-native-android-widget → widgets[].name` 必须一字不差。
 *
 * 单独放一个文件是因为有四处引用它（task-handler / publish / app.json 的手抄 / 文档），
 * 而拼错一个字母的症状是"widget 加到桌面上永远是初始布局" —— 不报错，只是不刷新。
 */
export const WIDGET_NAME = 'GridToday';
