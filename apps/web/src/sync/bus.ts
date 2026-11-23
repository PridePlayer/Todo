/**
 * 同步引擎与写入层之间的单向通知通道。
 *
 * 为什么不让 repo.ts 直接 import engine.ts：那会是循环依赖（engine → db，repo → engine → db），
 * ESM 虽然能靠提升函数声明糊过去，但初始化顺序一变就炸在某个奇怪的 `undefined is not a function` 上。
 * 事件总线把方向掰直：写入层只管喊"我改了"，谁来听、听几遍是引擎的事。
 *
 * 刻意不做成通用 EventEmitter：这里只有"本地有新操作"和"同步状态变了"两件事，
 * 一个泛型发射器会把调用点变成 `bus.emit('outbox:changed')` 这种字符串魔法，改个名字编译器不管。
 */

type Listener = () => void;

const localListeners = new Set<Listener>();

/** 队列里多了一条操作（新建 / 改字段 / 软删 / 撤单都算） */
export function notifyLocalChange(): void {
  for (const listener of localListeners) listener();
}

export function onLocalChange(listener: Listener): () => void {
  localListeners.add(listener);
  return () => localListeners.delete(listener);
}
