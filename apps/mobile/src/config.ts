import * as SecureStore from 'expo-secure-store';

const BASE_KEY = 'grid.api.base';

/**
 * 后端地址。
 *
 * 默认直连生产，而不是"自动发现局域网 IP"。
 *
 * 一开始写的是从 Expo 的 `hostUri` 推导出开发机 IP，省去手填。
 * 但那条路有个致命前提：手机必须和电脑同一个 WiFi、电脑必须开着、
 * 后端必须监听 0.0.0.0 —— 三个条件里任何一个不满足，App 打开就是
 * "连不上服务器"，而用户在手机上根本没法排查是哪一条。
 *
 * 自托管的意义就是"在哪都能用自己的数据"。需要打本地后端时到设置页改，
 * 那是一次性的显式动作。
 */
const PROD_BASE = 'https://todo.stellamp.me';

let cached: string | null = null;

export async function loadApiBase(): Promise<string> {
  if (cached) return cached;
  const saved = await SecureStore.getItemAsync(BASE_KEY).catch(() => null);
  // 默认直连生产：手机不该依赖"电脑正在开着并且同一 WiFi"才能用。
  // 需要打本地后端时到设置页改地址，那是一次性的。
  cached = saved ?? PROD_BASE;
  return cached;
}

export function currentApiBase(): string {
  return cached ?? PROD_BASE;
}

export async function setApiBase(value: string): Promise<string> {
  // 尾部斜杠会让拼接变成 `//api/sync/pull`，某些反代会当成不同路径
  const normalized = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+$/.test(normalized)) {
    throw new Error('地址要写成 http(s)://主机[:端口]，不要带 /api 后缀');
  }
  cached = normalized;
  await SecureStore.setItemAsync(BASE_KEY, normalized);
  return normalized;
}

/** 恢复默认（生产地址） */
export async function resetApiBase(): Promise<string> {
  await SecureStore.deleteItemAsync(BASE_KEY).catch(() => undefined);
  cached = PROD_BASE;
  return cached;
}
