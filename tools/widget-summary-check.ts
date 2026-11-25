/**
 * 小组件摘要的纯函数验收（docs/11 §6 的一部分）。
 *
 * 不打数据库、不启服务：`buildWidgetSummary` 是纯函数，构造几条任务就能把
 * 那些容易错的口径全钉住。这里每一条都对应一个真实会出错的点：
 *   · 逾期必须排在今日前面（否则最该做的事沉到看不见的地方）
 *   · 收件箱不计入 openCount（否则"未完成 N"永远比 App 首屏大）
 *   · 只返回 4 条（3 条显示 + 1 条补位，多了白渲染）
 *   · 已完成 / 未来日期 / 归档习惯一律不出现
 *   · 连续天数：今天没打卡不算断（否则每天 0 点全体归零）
 *
 * 用法：cd packages/server && ./node_modules/.bin/tsx ../../tools/widget-summary-check.ts
 */
import {
  buildWidgetSummary,
  type WidgetHabitLike,
  type WidgetLogLike,
  type WidgetTaskLike,
} from '../packages/core/dist/index.js';

const TODAY = '2026-11-24';
const dayStart = new Date(2026, 10, 24).getTime();
const dayEnd = dayStart + 86_400_000;
const yesterday = '2026-11-23';
const tomorrow = '2026-11-25';

function task(partial: Partial<WidgetTaskLike> & { id: string }): WidgetTaskLike {
  return {
    title: partial.id,
    quadrant: 1,
    dueDate: null,
    startAt: null,
    allDay: true,
    completedAt: null,
    rrule: null,
    sortOrder: 0,
    rev: 1,
    ...partial,
  };
}

function habit(partial: Partial<WidgetHabitLike> & { id: string }): WidgetHabitLike {
  return {
    name: partial.id,
    type: 'check',
    target: 1,
    unit: null,
    colorKey: 0,
    daysOfWeek: [],
    archivedAt: null,
    deletedAt: null,
    ...partial,
  };
}

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── 待办口径 ────────────────────────────────────────────────
const tasks: WidgetTaskLike[] = [
  task({ id: 'overdue-1', dueDate: yesterday, quadrant: 1 }),
  task({ id: 'overdue-2', dueDate: '2026-11-20', quadrant: 3 }),
  task({ id: 'today-allday', dueDate: TODAY, quadrant: 2 }),
  task({ id: 'today-timed', startAt: dayStart + 9 * 3_600_000, allDay: false, quadrant: 4 }),
  task({ id: 'today-timed-early', startAt: dayStart + 8 * 3_600_000, allDay: false, quadrant: 3 }),
  task({ id: 'inbox-1' }),
  task({ id: 'tomorrow-1', dueDate: tomorrow }),
  task({ id: 'done-1', dueDate: TODAY, completedAt: Date.now() }),
  task({ id: 'recurring-today', dueDate: TODAY, rrule: 'FREQ=DAILY', quadrant: 1 }),
];

const summary = buildWidgetSummary({
  tasks,
  habits: [],
  logs: [],
  today: TODAY,
  dayStart,
  dayEnd,
  now: dayStart + 10 * 3_600_000,
});

check('openCount = 逾期 2 + 今日 4（不含收件箱/明天/已完成）', summary.openCount === 6, `得到 ${summary.openCount}`);
check('只返回 4 条', summary.tasks.length === 4, `得到 ${summary.tasks.length}`);
check(
  '逾期排在最前',
  summary.tasks.slice(0, 2).every((item) => item.overdue) && summary.tasks[2]?.overdue === false,
  summary.tasks.map((t) => `${t.id}${t.overdue ? '(逾期)' : ''}`).join(', '),
);
check('逾期内部按象限（1 在前）', summary.tasks[0]?.id === 'overdue-1', summary.tasks[0]?.id ?? '');
check(
  '今日内部全天任务排在有时间的前面',
  summary.tasks[2]?.startAt === null,
  `第 3 条是 ${summary.tasks[2]?.id}（startAt=${String(summary.tasks[2]?.startAt)}）`,
);
check('重复任务也在今日里', summary.tasks.some((t) => t.id === 'recurring-today'));
check('未来日期不出现', !summary.tasks.some((t) => t.id === 'tomorrow-1'));
check('已完成不出现', !summary.tasks.some((t) => t.id === 'done-1'));
check('收件箱不出现', !summary.tasks.some((t) => t.id === 'inbox-1'));

// ── 打卡与连续天数 ──────────────────────────────────────────
const habits: WidgetHabitLike[] = [
  habit({ id: 'daily' }),
  habit({ id: 'monday-only', daysOfWeek: [0] }), // 2026-11-24 是周二
  habit({ id: 'archived', archivedAt: 1 }),
  habit({ id: 'count-3', type: 'count', target: 3 }),
];

const logs: WidgetLogLike[] = [
  { habitId: 'daily', logDate: yesterday, value: 1, deletedAt: null },
  { habitId: 'daily', logDate: TODAY, value: 1, deletedAt: null },
  // count 型目标 3，只打了 2 → 不算达标
  { habitId: 'count-3', logDate: TODAY, value: 2, deletedAt: null },
  // 已删除的记录不能算
  { habitId: 'count-3', logDate: yesterday, value: 3, deletedAt: 1 },
];

const habitSummary = buildWidgetSummary({
  tasks: [],
  habits,
  logs,
  today: TODAY,
  dayStart,
  dayEnd,
  now: dayStart + 10 * 3_600_000,
});

check('只排今天的习惯（周二不含"只排周一"、不含归档）', habitSummary.habitTotal === 2, `得到 ${habitSummary.habitTotal}`);
check('归档习惯不出现', !habitSummary.habits.some((h) => h.id === 'archived'));
check('连续两天达标 → current = 2', habitSummary.maxStreak === 2, `得到 ${habitSummary.maxStreak}`);
check(
  'daily 今天已达标',
  habitSummary.habits.find((h) => h.id === 'daily')?.doneToday === true,
);
check(
  'count 型未达目标不算达标',
  habitSummary.habits.find((h) => h.id === 'count-3')?.doneToday === false,
);
// 这两条是给小组件画"点了但还没到目标"的状态用的：光有 doneToday 不够，
// 目标 8 杯水喝到 3 杯时，桌面上必须能看出"点了有反应"
check(
  'daily 今天 value = 1',
  habitSummary.habits.find((h) => h.id === 'daily')?.value === 1,
  `得到 ${String(habitSummary.habits.find((h) => h.id === 'daily')?.value)}`,
);
check(
  'count 型当前值 = 2（未达标也要带出来）',
  habitSummary.habits.find((h) => h.id === 'count-3')?.value === 2,
  `得到 ${String(habitSummary.habits.find((h) => h.id === 'count-3')?.value)}`,
);

// 今天没打卡不算断：只有昨天打了 → current 应该是 1
const notToday = buildWidgetSummary({
  tasks: [],
  habits: [habit({ id: 'daily' })],
  logs: [{ habitId: 'daily', logDate: yesterday, value: 1, deletedAt: null }],
  today: TODAY,
  dayStart,
  dayEnd,
});
check('今天没打卡不算断（current = 1）', notToday.maxStreak === 1, `得到 ${notToday.maxStreak}`);

// 超过 4 个习惯时，第 5 个的连续天数仍要计入大数字
const manyHabits = Array.from({ length: 5 }, (_, index) => habit({ id: `h${index}` }));
const manyLogs = [
  { habitId: 'h4', logDate: TODAY, value: 1, deletedAt: null },
  { habitId: 'h4', logDate: yesterday, value: 1, deletedAt: null },
];
const manySummary = buildWidgetSummary({
  tasks: [],
  habits: manyHabits,
  logs: manyLogs,
  today: TODAY,
  dayStart,
  dayEnd,
});
check('打卡最多返回 3 行（与待办对等）', manySummary.habits.length === 3, `得到 ${manySummary.habits.length}`);
check('habitTotal 是全部 5 个', manySummary.habitTotal === 5, `得到 ${manySummary.habitTotal}`);
check('第 5 个习惯的连续天数计入 maxStreak', manySummary.maxStreak === 2, `得到 ${manySummary.maxStreak}`);

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
