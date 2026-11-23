/**
 * 跨标签页广播。
 *
 * IndexedDB 的写入本来就会被 liveQuery 感知到，所以这里不传数据，只传"发生了什么"：
 * 另一页刚入队了一条操作，本页也该尽快推一次；另一页刚同步完，本页把状态数字刷新一下。
 *
 * 不广播数据本体有两个原因：结构化克隆有个隐形成本（每条任务几百字节，量大时肉眼可见卡顿），
 * 而且数据一旦通过消息传递，"谁是唯一真源"就模糊了——读源必须永远是本地库。
 */

const CHANNEL_NAME = 'grid:sync';

export type SyncBroadcast =
  | { type: 'local-change' }
  | { type: 'synced'; at: number };

const channel: BroadcastChannel | null =
  typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null;

export function broadcast(message: SyncBroadcast): void {
  try {
    channel?.postMessage(message);
  } catch {
    // 通道被关闭（页面正在卸载）时 postMessage 会抛，忽略即可
  }
}

export function onBroadcast(handler: (message: SyncBroadcast) => void): () => void {
  if (!channel) return () => undefined;
  const listener = (event: MessageEvent<SyncBroadcast>): void => {
    if (event.data && typeof event.data.type === 'string') handler(event.data);
  };
  channel.addEventListener('message', listener);
  return () => channel.removeEventListener('message', listener);
}
