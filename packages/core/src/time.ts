/**
 * 时区处理。
 *
 * 为什么不用 `new Date('2026-11-24T10:00:00')` 直接解析 Graph 返回的时间：
 * Graph 的 `dateTime` 是**没有偏移量的墙上时间**（例如 "2026-11-24T10:00:00.0000000"），
 * 它配一个 `timeZone` 字段说明这个墙上时间属于哪个时区。浏览器解析裸字符串时
 * 会按"本地时区"理解——如果用户在中国、而事件是纽约时间 10:00，就会算成北京时间 10:00，
 * 差 13 小时。这类错误在日历上表现为"会议跑到半夜"，而且不会抛任何异常。
 *
 * 所以必须：拿到墙上时间 + 时区名 → 显式算出 epoch。
 */

/**
 * 微软返回的是 Windows 时区名（"China Standard Time"），Intl 只认 IANA（"Asia/Shanghai"）。
 * 只覆盖常见项：没命中且不是 IANA 形态时退回本机时区，而不是抛错——
 * 一个时区名不认识不该让整次同步失败。
 */
const WINDOWS_TZ: Record<string, string> = {
  UTC: 'UTC',
  'Dateline Standard Time': 'Etc/GMT+12',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Mountain Standard Time': 'America/Denver',
  'Central Standard Time': 'America/Chicago',
  'Eastern Standard Time': 'America/New_York',
  'Atlantic Standard Time': 'America/Halifax',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'FLE Standard Time': 'Europe/Kiev',
  'Russian Standard Time': 'Europe/Moscow',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'China Standard Time': 'Asia/Shanghai',
  'Taipei Standard Time': 'Asia/Taipei',
  'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
};

/** 本机时区（IANA）。拿不到就退回 UTC，绝不返回 undefined */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Windows 时区名 → IANA。已是 IANA 形态的原样返回；都不像则用兜底时区 */
export function toIanaTimeZone(name: string | null | undefined, fallback: string = systemTimeZone()): string {
  if (typeof name !== 'string' || name.trim() === '') return fallback;
  const raw = name.trim();
  const mapped = WINDOWS_TZ[raw];
  if (mapped) return mapped;
  // IANA 形如 Asia/Shanghai、America/Argentina/Buenos_Aires
  if (/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+$/.test(raw)) return raw;
  return fallback;
}

/**
 * 某个瞬时在指定时区的偏移量（毫秒，东正西负）。
 * 用 Intl 把瞬时格式化成该时区的墙上时间，再把这个墙上时间当成 UTC 反解，
 * 差值就是偏移。这样不需要维护夏令时表。
 */
function offsetMsAt(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const pick = (type: string): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };
  // hour12:false 在部分运行时会给出 24 点表示午夜，归一成 0
  const hour = pick('hour') % 24;
  const asUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), hour, pick('minute'), pick('second'));
  return asUtc - utcMs;
}

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * "墙上时间 + 时区" → epoch 毫秒。
 *
 * 解析不出来返回 null（调用方决定是跳过这条还是报错），绝不返回 NaN——
 * NaN 进了数据库会变成 0，然后在日历上显示成 1970 年。
 */
export function parseZonedDateTime(naive: string, timeZone: string): number | null {
  const match = NAIVE.exec(naive);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  if (!Number.isFinite(wall)) return null;

  let zone: string;
  try {
    zone = toIanaTimeZone(timeZone);
    // 试探一次，让无效时区在这里就抛而不是悄悄算错
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
  } catch {
    zone = 'UTC';
  }

  // 两轮迭代：第一轮用"墙钟当 UTC"估偏移，第二轮用估出来的瞬时重新求偏移，
  // 足以覆盖夏令时切换当天（偏移在切换前后相差 1 小时）
  let instant = wall - offsetMsAt(wall, zone);
  instant = wall - offsetMsAt(instant, zone);
  return instant;
}

/** epoch → 某时区的 'YYYY-MM-DDTHH:mm:ss'（Graph 回写时要的是这种无偏移的墙上时间） */
export function formatZonedDateTime(ts: number, timeZone: string = systemTimeZone()): string {
  const zone = toIanaTimeZone(timeZone);
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(ts));
  const pick = (type: string): string => {
    const found = parts.find((part) => part.type === type);
    return found ? found.value : '00';
  };
  const hour = String(Number(pick('hour')) % 24).padStart(2, '0');
  return `${pick('year')}-${pick('month')}-${pick('day')}T${hour}:${pick('minute')}:${pick('second')}`;
}

/** epoch → 某时区的 'YYYY-MM-DD'。用于"今天是几号"这类跟着时区走的判断 */
export function dateKeyInZone(ts: number, timeZone: string = systemTimeZone()): string {
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: toIanaTimeZone(timeZone),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // en-CA 的默认输出就是 YYYY-MM-DD
    return dtf.format(new Date(ts));
  } catch {
    const d = new Date(ts);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
}
