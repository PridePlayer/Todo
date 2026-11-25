import {
  buildWidgetSummary,
  widgetLogWindowStart,
  widgetSummaryQuerySchema,
  type WidgetHabitLike,
  type WidgetLogLike,
  type WidgetTaskLike,
} from '@grid/core';
import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth/require.js';
import type { Db, Row } from '../db/types.js';
import type { AppEnv } from '../env.js';
import { HttpError } from '../http/errors.js';
import { rowToPayload } from '../sync/task-map.js';

interface Deps {
  db: Db;
  env: AppEnv;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 行 → 小组件需要的轻量结构。
 *
 * 不走 `taskSchema.safeParse`：这里只用 9 个字段，而用户可能有几千条任务，
 * 每条都过一遍 zod 是纯浪费。缺字段一律给安全默认值 —— 小组件画错一行
 * 也远好过整个接口 500。
 */
function toTaskLike(row: Row): WidgetTaskLike {
  const payload = rowToPayload('task', row);
  return {
    id: String(row.id),
    title: strOrNull(payload.title) ?? '(无标题)',
    quadrant: Number(payload.quadrant ?? 1),
    dueDate: strOrNull(payload.dueDate),
    startAt: numOrNull(payload.startAt),
    allDay: payload.allDay === true,
    completedAt: numOrNull(payload.completedAt),
    rrule: strOrNull(payload.rrule),
    sortOrder: Number(payload.sortOrder ?? 0),
    rev: Number(row.rev),
  };
}

function toHabitLike(row: Row): WidgetHabitLike {
  const payload = rowToPayload('habit', row);
  return {
    id: String(row.id),
    name: strOrNull(payload.name) ?? '(未命名)',
    type: strOrNull(payload.type) ?? 'check',
    target: Math.max(1, Number(payload.target ?? 1)),
    unit: strOrNull(payload.unit),
    colorKey: Number(payload.colorKey ?? 0),
    daysOfWeek: Array.isArray(payload.daysOfWeek)
      ? payload.daysOfWeek.filter((d): d is number => typeof d === 'number')
      : [],
    archivedAt: numOrNull(payload.archivedAt),
    deletedAt: null,
  };
}

/**
 * 桌面小组件的读接口（docs/11）。
 *
 * 只读。写操作一律走 /sync/push —— 与 habits.ts 同一条纪律：
 * 两条写路径各自维护合并语义，迟早会分叉，而分叉的症状是"小组件改的东西
 * 在某台设备上永远同步不过去"，这种 bug 极难复现。
 *
 * 这是 widget 令牌**唯一**被允许访问的端点（见 auth/require.ts 的默认拒绝）。
 * 计算全在 core 的 buildWidgetSummary 里 —— App 主动刷桌面时调用的是同一个函数，
 * 所以两处出的数字永远不会不一样。
 */
export async function widgetRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { db, env } = deps;

  app.get('/widget/summary', async (req) => {
    // 用 authenticate 而不是 requireUser：后者会把 widget 令牌挡在门外，
    // 而这个端点正是它被允许访问的那一个。
    const authed = await authenticate(db, env, req);

    const parsed = widgetSummaryQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_query', '缺少 today / dayStart / dayEnd');
    }
    const { today, dayStart, dayEnd } = parsed.data;
    if (dayEnd <= dayStart) throw new HttpError(400, 'invalid_query', 'dayEnd 必须大于 dayStart');

    const userId = authed.userId;

    const taskRows = await db.query<Row>(
      'SELECT * FROM task WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL ' +
        'AND completed_at IS NULL LIMIT 2000',
      [userId],
    );

    const habitRows = await db.query<Row>(
      'SELECT * FROM habit WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL',
      [userId],
    );

    const logRows = await db.query<Row>(
      'SELECT habit_id, log_date, value, deleted_at FROM habit_log WHERE user_id = ? AND deleted_at IS NULL ' +
        'AND log_date >= ? AND log_date <= ?',
      [userId, widgetLogWindowStart(today), today],
    );

    const logs: WidgetLogLike[] = logRows.map((row) => ({
      habitId: String(row.habit_id),
      logDate: String(row.log_date),
      value: Number(row.value ?? 0),
      deletedAt: null,
    }));

    return buildWidgetSummary({
      tasks: taskRows.map(toTaskLike),
      habits: habitRows.map(toHabitLike),
      logs,
      today,
      dayStart,
      dayEnd,
    });
  });
}
