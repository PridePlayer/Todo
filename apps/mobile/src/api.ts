import { createApiClient } from '@grid/core';
import { currentAuth } from './auth';
import { currentApiBase } from './config';

/**
 * API 客户端工厂。
 *
 * 为什么抽出来：widget 的 headless 任务也在打同一批接口，而它没有 React 上下文、
 * 也没有"登录时缓存在内存里的 auth state"。让它自己拼一份 baseUrl 和 headers，
 * 就等于两条请求路径各自演进——某天服务端改了鉴权头，App 改了、widget 没改，
 * 症状是"桌面小组件永远显示登录已过期"。
 *
 * `token` 显式传入时优先（headless 用）；不传则走当前登录态（App 内用）。
 */
export function makeApiClient(token?: string) {
  return createApiClient({
    baseUrl: `${currentApiBase()}/api`,
    // 每次现取：令牌静默轮换后不需要重启 App
    authToken: () => token ?? currentAuth()?.token ?? null,
  });
}
