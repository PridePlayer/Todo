import { dayNumber } from './date.js';

/**
 * 打卡记录的主键：`hash(habitId + logDate)` 的确定性生成。
 *
 * 为什么不能像别的表那样用随机 ULID —— 这是 M5 里唯一一个**必须**确定性的地方：
 *
 *   设备 A 今天点了"喝水 +1"，生成 op-create(id=X, value=3)
 *   设备 B 今天也点了"喝水 +1"，生成 op-create(id=Y, value=5)
 *
 * 随机 id 时两条都是"新行"，服务端各插一条，界面上 3 + 5 变成 8/8 ——
 * 用户看到的是"打卡翻倍"，而且**没有任何后续操作能纠正**：
 * 本地已经是两条了，下一次同步只是把它俩再确认一遍。
 *
 * 确定性 id 之后，B 的 op 命中的是同一行，于是走"同一条记录的字段级合并"，
 * 再由 sync/merge.ts 里的 GREATEST 规则取较大值 —— 这才叫"两台设备各点一次 = 一次"。
 *
 * 编码沿用 ULID 的 Crockford base32 与 26 字符长度，因为服务端列是 VARCHAR(26)，
 * 且沿用同一套字符集能让 `isUlid` 这类既有校验继续成立。
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 定宽 base32。宽度不够时高位补 0，保证长度恒定（主键长度不齐会让索引比较变得奇怪） */
function base32(value: number, width: number): string {
  let out = '';
  let rest = Math.max(0, Math.trunc(value));
  for (let i = 0; i < width; i += 1) {
    out = CROCKFORD[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/**
 * 26 字符 = 6（日序号）+ 4 × 5（四路哈希）。
 *
 * 前 6 位放日期而不是放"当前时间"：同一个习惯的记录按 id 排序时天然是时间序，
 * 将来做"最近 30 天"的范围查询可以直接在 id 上扫，不必回表看 log_date。
 */
export function habitLogId(habitId: string, logDate: string): string {
  const day = dayNumber(logDate);
  const prefix = Number.isFinite(day) && day > 0 ? base32(day, 6) : '000000';

  const seed = `${habitId}|${logDate}`;
  // 四路不同的混合函数，避免"两段字符串换序后哈希相同"这种在手写哈希里很常见的退化
  let h0 = 0x811c9dc5;
  let h1 = 0x9e3779b9;
  let h2 = 0x5bd1e995;
  let h3 = 0x27d4eb2f;
  for (let i = 0; i < seed.length; i += 1) {
    const c = seed.charCodeAt(i);
    h0 = Math.imul(h0 ^ c, 0x01000193) >>> 0;
    h1 = Math.imul(h1 + c + 1, 0x85ebca6b) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0xcc9e2d51) >>> 0;
    h3 = (h3 ^ Math.imul(c + (h3 >>> 16), 0x1b873593)) >>> 0;
    h3 = ((h3 << 13) | (h3 >>> 19)) >>> 0;
  }

  // 收尾雪崩：最后一轮字符的影响只落在低位，不做这一步会让"只差一个结尾字符"的
  // 两组输入在前 5 位上大量相同，界面上表现为 id 长得几乎一样（不好看，也不好排查）
  const mix = (value: number): number => {
    let v = (value ^ seed.length) >>> 0;
    v = Math.imul(v ^ (v >>> 16), 0x85ebca6b) >>> 0;
    v = Math.imul(v ^ (v >>> 13), 0xc2b2ae35) >>> 0;
    return (v ^ (v >>> 16)) >>> 0;
  };

  return prefix + [mix(h0), mix(h1), mix(h2), mix(h3)].map((v) => base32(v, 5)).join('');
}

/** 服务端用它拒绝"客户端自己乱造 id"的打卡记录：乱造 id 等于让同一天出现两行，数值会翻倍 */
export function isHabitLogId(id: string, habitId: string, logDate: string): boolean {
  return id === habitLogId(habitId, logDate);
}
