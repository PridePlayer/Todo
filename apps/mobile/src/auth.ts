import { ulid } from '@grid/core';
import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'grid.device.token';
const USER_KEY = 'grid.device.user';
const DEVICE_KEY = 'grid.device.id';

export interface AuthState {
  token: string;
  userId: string;
  email: string;
  expiresAt: number;
}

let state: AuthState | null = null;
let deviceId: string | null = null;

/**
 * 设备令牌与身份的本地存储。
 *
 * 用 SecureStore 而不是 AsyncStorage：令牌等价于密码（180 天内可完全代替登录），
 * 明文躺在应用私有目录里，root 或备份导出就能读走。
 *
 * 内存里再缓一份是为了让 `authToken: () => ...` 这个同步取值器不必变成 async ——
 * 每个请求都 await 一次磁盘，在弱网下会放大成可感知的卡顿。
 */
export async function loadAuth(): Promise<AuthState | null> {
  if (state) return state;
  const raw = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AuthState;
    if (typeof parsed.token !== 'string' || typeof parsed.userId !== 'string') return null;
    // 本地先挡一次过期：不挡的话要等第一个请求 401 才知道，界面上会闪一下红条
    if (parsed.expiresAt > 0 && parsed.expiresAt < Date.now()) {
      await clearAuth();
      return null;
    }
    state = parsed;
    return state;
  } catch {
    return null;
  }
}

export function currentAuth(): AuthState | null {
  return state;
}

export async function saveAuth(next: AuthState): Promise<void> {
  state = next;
  await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(next));
  // 邮箱单独存一份：令牌失效后登录页要预填，不能因为没令牌就把邮箱也忘了
  await SecureStore.setItemAsync(USER_KEY, next.email).catch(() => undefined);
}

export async function rememberedEmail(): Promise<string | null> {
  return SecureStore.getItemAsync(USER_KEY).catch(() => null);
}

export async function clearAuth(): Promise<void> {
  state = null;
  await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => undefined);
}

/**
 * 本机设备号（写进 HLC 与 sync push 的 deviceId）。
 *
 * 生成一次后就不变：换号会让服务端把同一台手机当成两台设备，
 * 冲突日志里全是"自己和自己的冲突"。
 */
export async function ensureDeviceId(): Promise<string> {
  if (deviceId) return deviceId;
  const saved = await SecureStore.getItemAsync(DEVICE_KEY).catch(() => null);
  if (saved) {
    deviceId = saved;
    return saved;
  }
  const fresh = ulid();
  await SecureStore.setItemAsync(DEVICE_KEY, fresh).catch(() => undefined);
  deviceId = fresh;
  return fresh;
}

export function currentDeviceId(): string {
  return deviceId ?? 'unknown';
}
