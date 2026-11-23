import { ulid, type Hlc } from '@grid/core';
import { db } from '../db/dexie';

const KEY_DEVICE = 'deviceId';
const KEY_WALL = 'hlcWall';
const KEY_COUNTER = 'hlcCounter';

export async function getMeta(key: string): Promise<string | null> {
  const row = await db.meta.get(key);
  return row?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}

export async function getDeviceId(): Promise<string> {
  const existing = await getMeta(KEY_DEVICE);
  if (existing) return existing;
  const id = ulid();
  await setMeta(KEY_DEVICE, id);
  return id;
}

/**
 * Hybrid Logical Clock。
 *
 * 为什么不用 `Date.now()` 直接定序：同一毫秒内的两次写入无法区分先后，
 * 而"改标题"和"取消完成"完全可能落在同一毫秒。计数器解决同毫秒定序，
 * 设备号解决"两台设备同毫秒"的最终仲裁（字典序，虽然任意但**所有端一致**）。
 *
 * 读改写必须在一个事务里：并发 bump 会拿到相同的 (wall, counter)。
 */
export async function bumpHlc(): Promise<Hlc> {
  const device = await getDeviceId();
  return db.transaction('rw', db.meta, async () => {
    const wallRow = await db.meta.get(KEY_WALL);
    const counterRow = await db.meta.get(KEY_COUNTER);
    const lastWall = Number(wallRow?.value ?? 0);
    const lastCounter = Number(counterRow?.value ?? 0);

    const now = Date.now();
    const wall = Math.max(now, lastWall);
    const counter = wall === lastWall ? lastCounter + 1 : 0;

    await db.meta.put({ key: KEY_WALL, value: String(wall) });
    await db.meta.put({ key: KEY_COUNTER, value: String(counter) });
    return { wall, counter, device };
  });
}
