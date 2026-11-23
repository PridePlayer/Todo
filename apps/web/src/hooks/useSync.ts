import { useSyncExternalStore } from 'react';
import { getSyncStatus, subscribeSyncStatus, syncNow, type SyncStatus } from '../sync/engine';

/**
 * 订阅同步状态。
 *
 * 用 useSyncExternalStore 而不是 useState + useEffect 订阅：
 * 后者的顺序是"先渲染一次旧值，再订阅，再 setState 触发第二次渲染"，
 * 顶栏胶囊会闪两帧；同步状态变化频繁，这个闪烁会被看见。
 *
 * getServerSnapshot 直接给同一个快照：本项目不做 SSR，给个稳定实现只是为了让 React 闭嘴。
 */
export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribeSyncStatus, getSyncStatus, getSyncStatus);
}

export function useSyncNow(): () => void {
  return () => void syncNow();
}
