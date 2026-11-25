import type { Hlc } from '@grid/core';

/**
 * 混合逻辑时钟（HLC）。
 *
 * 为什么单独一个模块而不是留在 store.tsx 里：桌面小组件的 headless 任务
 * 也要写数据，而它没有 store 的 React 上下文。如果 widget 自己造一套时钟，
 * 两个实例在同一毫秒内产生的 (wall, counter) 会撞在一起 —— HLC 靠这个三元组
 * 定全序，撞了就没有全序，服务端的冲突裁决会随机选一个赢。
 *
 * 状态放在模块级（而不是持久化）：墙钟本身就是单调的，重启后从 Date.now()
 * 重新起步不会倒退。持久化反而会引入"手机时钟被调回去后 HLC 卡在将来"的问题。
 */
let wall = 0;
let counter = 0;

export function nextHlc(device: string): Hlc {
  const now = Date.now();
  if (now > wall) {
    wall = now;
    counter = 0;
  } else {
    // 同一毫秒内（或墙钟回拨）靠计数器保序
    counter += 1;
  }
  return { wall, counter, device };
}
