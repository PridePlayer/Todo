/**
 * 跨标签页同步互斥。
 *
 * 症状如果没有这层保护：同一账号开了 3 个标签页，每个都把 outbox 整批推一遍，
 * 服务端靠 opId 幂等兜住写入本身，但三份 /sync/pull 会交错覆盖本地游标，
 * 极端情况下 A 页刚拉到 seq=100 把游标写回库里，B 页用旧游标 60 又拉一遍——
 * 不致命（幂等 apply），但白烧流量，而且"已同步"的数字会跳。
 *
 * Web Locks 在无痕/老 Safari 里可能不存在，降级成进程内的串行链：
 * 单页内不再并发，跨页退化成"各推各的"，靠服务端幂等与游标单调收尾。
 */

const LOCK_NAME = 'grid:sync';

/** 降级路径用的串行链：把后来者挂在上一轮的 finally 后面 */
let chain: Promise<unknown> = Promise.resolve();

function withChain<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // 吞掉拒绝，否则一次失败会让后面所有等待者跟着 reject
  chain = run.catch(() => undefined);
  return run;
}

export async function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks || typeof locks.request !== 'function') return withChain(fn);
  return (await locks.request(LOCK_NAME, { mode: 'exclusive' }, fn)) as T;
}
