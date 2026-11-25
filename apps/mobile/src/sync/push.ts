import { ensureDeviceId } from '../auth';
import { applyServerPayload, bumpRev, dropOps, loadOps } from '../db/local';
import { makeApiClient } from '../api';

/**
 * outbox 推送。
 *
 * 从 store.tsx 抽出来的原因只有一个：桌面小组件的 headless 任务也要写数据。
 * 如果 widget 自己再写一份"发 op 给服务端"的代码，就会出现**两条写路径**，
 * 而两步之后它们的合并语义必然分叉（比如一边处理了 rev 回填、另一边没有，
 * 于是 widget 写的任务从此每次同步都被判成冲突）。服务端 habits.ts 的注释里
 * 也明确写过同一条纪律：写入只能有一条路。
 *
 * 这里不依赖任何 React：调用方是 store（App 内）或 widgetTaskHandler（无 UI），
 * 两者拿到的是同一份结果形状。
 */

export interface FlushOutcome {
  /** 本次实际提交的 op 条数（0 表示队列本来就是空的） */
  sent: number;
  /** 被服务端拒绝的 op 与原因。这类 op 会被丢弃，留着只会每次重试都失败 */
  rejected: { opId: string; reason: string }[];
}

/**
 * 并发锁放在模块级而不是调用方：
 * 同一时刻两个 flush 在飞，同一条 op 会被提交两次。服务端有 opId 幂等兜着，
 * 但客户端两边的 rev 回填会互相覆盖，最后落到"某条任务改一次要同步三次才生效"。
 */
let inFlight: Promise<FlushOutcome> | null = null;

export function flushOutbox(options: { token?: string } = {}): Promise<FlushOutcome> {
  if (inFlight) return inFlight;
  const task = runFlush(options).finally(() => {
    inFlight = null;
  });
  inFlight = task;
  return task;
}

async function runFlush(options: { token?: string }): Promise<FlushOutcome> {
  const ops = await loadOps();
  if (ops.length === 0) return { sent: 0, rejected: [] };

  // 设备号进 HLC 与 sync push 的 deviceId。headless 里如果读不到 SecureStore，
  // 这里会现生成一个新的 —— 症状是服务端把同一台手机记成两台设备，冲突日志里
  // 全是"自己和自己冲突"。第一次构建必须验这一条（docs/11 §5 验收第 6 项）。
  const device = await ensureDeviceId();
  const client = makeApiClient(options.token);

  // 网络错误与 401 由这里直接抛出：调用方（store.refresh）要靠它区分 offline / error，
  // 吞掉错误会让界面上那个"离线横幅"永远不出现。
  const response = await client.syncPush({ deviceId: device, ops: ops.map((op) => op.body) });

  const settled: string[] = [];
  const rejected: { opId: string; reason: string }[] = [];

  for (const result of response.results) {
    if (result.status === 'applied' || result.status === 'duplicate' || result.status === 'conflict') {
      settled.push(result.opId);
      const op = ops.find((item) => item.opId === result.opId);
      if (!op) continue;

      if (typeof result.rev === 'number' && result.rev > 0) {
        if (result.serverPayload) {
          // 服务端合并后的真实行。必须落地 —— 打卡值取 GREATEST、标签取并集，
          // 也就是说"推上去的"经常不等于"最终生效的"。只更新 rev 会让本地
          // 永远停在旧值上（服务端该行 change_seq 没变，之后的 pull 也拉不到它）。
          await applyServerPayload(op.body.table, op.body.id, result.rev, result.serverPayload);
        } else {
          // 服务端给了新 rev 就跟上，否则下一次 push 的 baseRev 永远是旧的 → 一直被当成冲突
          await bumpRev(op.body.table, op.body.id, result.rev);
        }
      }
      continue;
    }
    if (result.status === 'rejected') {
      // 被拒的不能留：留着每次同步都重试，且永远失败
      settled.push(result.opId);
      rejected.push({ opId: result.opId, reason: result.reason ?? '有一条改动被服务端拒绝' });
    }
  }

  await dropOps(settled);
  return { sent: ops.length, rejected };
}
