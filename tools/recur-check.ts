/**
 * 重复规则的数据层验收（docs/05 M3 的 6 条）。
 *
 * 不依赖浏览器：这里验的是"算得对不对"，UI 是否把按钮摆对是另一回事。
 * 跑法：node_modules/.bin/tsx tools/recur-check.ts
 */

import {
  expandSeries,
  formatRrule,
  parseRrule,
  planSkip,
  planThisAndFollowing,
  planThisOnly,
  rruleFromPreset,
  weekdayOf,
  type RecurExceptionLike,
  type SeriesLike,
} from '../packages/core/src/index.js';

let pass = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failures.push(`${label} ${detail}`);
    console.log(`  ✗ ${label}${detail ? `  ${detail}` : ''}`);
  }
}

const DAY = 24 * 60 * 60 * 1000;
/** 2026-03-02 是周一 */
const MON = new Date(2026, 2, 2, 9, 0, 0, 0).getTime();

function series(partial: Partial<SeriesLike> & { id?: string } = {}): SeriesLike {
  return {
    id: 'S1',
    title: '周会',
    startAt: MON,
    endAt: MON + 60 * 60 * 1000,
    allDay: false,
    rrule: rruleFromPreset('weekly', MON),
    exceptions: [],
    ...partial,
  };
}

function fmt(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${weekdayOf(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

console.log('\nM3 重复规则验收\n');

// ── 1) 每周一三五 09:00，未来 4 周 ─────────────────────────
{
  const base = new Date(2026, 2, 2, 9, 0).getTime();
  const s = series({ startAt: base, endAt: base + 3600_000, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR' });
  const from = base;
  const to = base + 28 * DAY;
  const list = expandSeries(s, from, to);
  const days = list.map((o) => weekdayOf(new Date(o.start)));
  check(
    '每周一三五：4 周 12 次，星期全对',
    list.length === 12 && days.every((d) => d === 'MO' || d === 'WE' || d === 'FR'),
    `${list.length} 次 ${fmt(list[0]!.start)} → ${fmt(list.at(-1)!.start)}`,
  );
  check(
    '每次时间都是 09:00、不是全天',
    list.every((o) => new Date(o.start).getHours() === 9 && o.allDay === false),
    fmt(list[0]!.start),
  );
}

// ── 2) 仅本次改周三那一次的时间 ────────────────────────────
{
  const base = MON;
  const third = MON + 2 * DAY; // 周三
  const s = series({ startAt: base, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR' });
  const list = expandSeries(s, base, base + 14 * DAY);
  const target = list.find((o) => o.originalStart === third)!;
  const draft = planThisOnly(s, target, { startAt: third + 5 * 3600_000, endAt: third + 6 * 3600_000 });
  check('仅本次：生成了 override 例外', draft !== null && draft.kind === 'override');

  const exceptions: RecurExceptionLike[] = [
    {
      id: 'E1',
      seriesId: 'S1',
      originalStart: draft!.originalStart,
      kind: 'override',
      overrideStart: draft!.overrideStart,
      overrideEnd: draft!.overrideEnd,
      overrideTitle: draft!.overrideTitle,
      deletedAt: null,
    },
  ];
  const after = expandSeries({ ...s, exceptions }, base, base + 14 * DAY);
  const moved = after.find((o) => o.originalStart === third)!;
  const others = after.filter((o) => o.originalStart !== third);
  check(
    '仅本次：周三挪到 14:00，其他天不动',
    new Date(moved.start).getHours() === 14 && others.every((o) => new Date(o.start).getHours() === 9),
    `${fmt(moved.start)} / 其余 ${others.length} 次仍 09:00`,
  );
}

// ── 3) 本次及后续改标题：之前的保持，原系列被截断 ──────────
{
  const base = MON;
  const third = MON + 2 * DAY;
  const s = series({ startAt: base, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR' });
  const list = expandSeries(s, base, base + 28 * DAY);
  const target = list.find((o) => o.originalStart === third)!;
  const plan = planThisAndFollowing(s, target, { title: '新标题' });

  check('本次及后续：原系列被截断到上一个实例（周一）', plan.masterRrule !== null && !plan.retireMaster);
  const truncated = parseRrule(plan.masterRrule!);
  check(
    '截断点 = 周一 09:00，而不是"cutoff 减一天"',
    truncated.until === MON,
    `UNTIL=${new Date(truncated.until!).toLocaleString('zh-CN')}（应等于首个周一）`,
  );

  const before = expandSeries({ ...s, rrule: plan.masterRrule! }, base, base + 28 * DAY);
  const nextSeries = series({ id: 'S2', startAt: plan.next.startAt, title: plan.next.title, rrule: plan.next.rrule });
  const after = expandSeries(nextSeries, base, base + 28 * DAY);

  check(
    '改之前的实例标题不变',
    before.every((o) => o.title === '周会') && before.length === 1,
    `旧系列剩 ${before.length} 次`,
  );
  check(
    '改之后的实例用新标题',
    after.every((o) => o.title === '新标题') && after.length === 11,
    `新系列 ${after.length} 次`,
  );
}

// ── 4) 删掉某一次 ──────────────────────────────────────────
{
  const base = MON;
  const third = MON + 2 * DAY;
  const s = series({ startAt: base, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR' });
  const draft = planSkip('S1', third);
  const exceptions: RecurExceptionLike[] = [
    { id: 'E2', seriesId: 'S1', originalStart: third, kind: 'deleted', overrideStart: null, overrideEnd: null, overrideTitle: null, deletedAt: null },
  ];
  const list = expandSeries({ ...s, exceptions }, base, base + 14 * DAY);
  check(
    '仅本次删除：那一天消失，且重复展开仍消失',
    draft.kind === 'deleted' &&
      list.every((o) => o.originalStart !== third) &&
      list.length === 5,
    `剩 ${list.length} 次`,
  );
}

// ── 5) 每月 31 日：2 月不出现 ──────────────────────────────
{
  const jan31 = new Date(2026, 0, 31, 10, 0).getTime();
  const s = series({ startAt: jan31, endAt: jan31 + 3600_000, rrule: 'FREQ=MONTHLY;BYMONTHDAY=31' });
  const list = expandSeries(s, jan31, new Date(2026, 5, 1).getTime());
  const months = list.map((o) => new Date(o.start).getMonth() + 1);
  check('每月 31 日：1/3/5 月各一次，2/4 月跳过且不报错', JSON.stringify(months) === '[1,3,5]', `月份 ${months.join(',')}`);
}

// ── 6) 每月最后一个周五 ────────────────────────────────────
{
  const base = new Date(2026, 0, 30, 15, 0).getTime(); // 2026-01-30 是周五
  const s = series({ startAt: base, rrule: 'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1' });
  const list = expandSeries(s, base, new Date(2026, 6, 1).getTime());
  // 2026-01-30 / 02-27 / 03-27 / 04-24 / 05-29 / 06-26
  const dates = list.map((o) => new Date(o.start).getDate());
  check('每月最后一个周五', JSON.stringify(dates) === '[30,27,27,24,29,26]', `日期 ${dates.join(',')}`);

  const feb = new Date(2026, 1, 27).getTime() + 0;
  check('每个都是周五', list.every((o) => weekdayOf(new Date(o.start)) === 'FR'), fmt(list[1]!.start));
  check('二月的最后一个周五是 27 号', new Date(list[1]!.start).getDate() === 27 && list[1]!.start >= feb);
}

// ── 7) 工作日规则 + COUNT ──────────────────────────────────
{
  const base = new Date(2026, 2, 2, 9, 0).getTime();
  const s = series({ startAt: base, rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10' });
  const list = expandSeries(s, base, base + 60 * DAY);
  check('工作日 + COUNT=10 只出 10 次', list.length === 10, `${list.length} 次`);
  check('COUNT 之后不再有实例', list.at(-1)!.start < base + 14 * DAY, fmt(list.at(-1)!.start));
}

// ── 8) 非法规则必须报错，而不是静默降级 ────────────────────
{
  const bad = ['FREQ=HOURLY', 'FREQ=WEEKLY;BYWEEKNO=3', 'FREQ=MONTHLY;BYSETPOS=2', 'FREQ=DAILY;COUNT=3;UNTIL=20260101T000000Z'];
  const threw = bad.map((text) => {
    try {
      parseRrule(text);
      return false;
    } catch {
      return true;
    }
  });
  check('不支持的语法一律抛错（不静默忽略）', threw.every(Boolean), bad.filter((_, i) => !threw[i]).join(' / ') || '4/4');
}

// ── 9) 序列化往返 ──────────────────────────────────────────
{
  const rule = parseRrule('BYDAY=MO,WE,FR;FREQ=WEEKLY;INTERVAL=2');
  const text = formatRrule(rule);
  check('序列化规范化为 FREQ 优先', text === 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR', text);
  check('往返后语义一致', JSON.stringify(parseRrule(text)) === JSON.stringify(rule));
}

console.log(`\n通过 ${pass} 项${failures.length ? `，失败 ${failures.length} 项` : ''}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
