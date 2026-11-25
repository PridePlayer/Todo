import {
  ApiError,
  habitLogId,
  habitLogSchema,
  recurExceptionSchema,
  taskSchema,
  widgetSummarySchema,
  type HabitLog,
  type RecurException,
  type Task,
  type WidgetSummary,
} from '@grid/core';
import { loadAuth } from '../auth';
import { makeApiClient } from '../api';
import { getMeta, loadAll, setMeta } from '../db/local';
import { localDayRange, localTodayKey } from '../domain/today';
import { checkHabit as writeHabitCheck, toggleTaskComplete } from '../domain/toggle';

/**
 * 桌面小组件的数据层。
 *
 * 三条存储纪律：
 *   1. **摘要缓存放在 sqlite 的 meta 表**里，不放 SecureStore —— 它不是秘密，
 *      而且 headless JS 能不能解开 SecureStore 是未知数。meta 表是明文 KV，
 *      读它只需要 expo-sqlite 能打开库。
 *   2. **小组件令牌也放 meta 表**。它 scope='widget'，只能读一个端点，
 *      被读走的损失上限是"今天有哪几条待办"，而不是整个账号。
 *      主令牌永远留在 SecureStore，headless 读不到就降级成"只读模式"。
 *   3. **缓存带日期**。跨天直接作废：昨天的三条待办出现在明天的桌面上，
 *      比一片空白更糟 —— 用户会以为那是今天的。
 */

const SUMMARY_KEY = 'widget.summary';
const TOKEN_KEY = 'widget.token';

export interface WidgetToken {
  token: string;
  expiresAt: number;
}

export type WidgetLoadReason = 'ok' | 'no-token' | 'expired' | 'offline' | 'error';

export interface WidgetLoadResult {
  summary: WidgetSummary | null;
  reason: WidgetLoadReason;
}

export async function readCachedSummary(): Promise<WidgetSummary | null> {
  try {
    const raw = await getMeta(SUMMARY_KEY);
    if (!raw) return null;
    const parsed = widgetSummarySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    if (parsed.data.today !== localTodayKey()) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export async function writeCachedSummary(summary: WidgetSummary): Promise<void> {
  try {
    await setMeta(SUMMARY_KEY, JSON.stringify(summary));
  } catch {
    // 缓存写失败不该让整个 widget 渲染失败：画面已经在内存里了
  }
}

export async function readWidgetToken(): Promise<WidgetToken | null> {
  try {
    const raw = await getMeta(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WidgetToken>;
    if (typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'number') return null;
    if (parsed.expiresAt <= Date.now()) return null;
    return { token: parsed.token, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export async function saveWidgetToken(token: WidgetToken): Promise<void> {
  await setMeta(TOKEN_KEY, JSON.stringify(token));
}

export async function clearWidgetToken(): Promise<void> {
  try {
    await setMeta(TOKEN_KEY, '');
  } catch {
    // ignore
  }
}

async function fetchSummary(token: string): Promise<WidgetSummary> {
  const { today, dayStart, dayEnd } = localDayRange();
  const summary = await makeApiClient(token).widgetSummary({ today, dayStart, dayEnd });
  await writeCachedSummary(summary);
  return summary;
}

/**
 * widget 醒来时的取数流程：**先远端、失败回缓存**。
 *
 * 顺序不能反。先画缓存意味着"点开桌面看到的是上一次的快照"，而过期数据
 * 在待办这个场景里是会误导人的（用户看着"3 条未完成"，其实已经做完了）。
 * 缓存只在拿不到数据时兜底 —— 那时它总比空白强。
 */
export async function loadWidgetSummary(): Promise<WidgetLoadResult> {
  const cached = await readCachedSummary();

  const widgetToken = await readWidgetToken();
  let token = widgetToken?.token ?? null;
  let usingWidgetToken = token !== null;

  if (!token) {
    // 退回主令牌。headless 里 SecureStore 能不能读是未知数，所以这里必须容错：
    // 读不到就当作没有令牌，widget 进入只读模式（还能显示缓存）。
    const auth = await loadAuth().catch(() => null);
    token = auth?.token ?? null;
    usingWidgetToken = false;
  }

  if (!token) {
    return { summary: cached, reason: cached ? 'ok' : 'no-token' };
  }

  try {
    return { summary: await fetchSummary(token), reason: 'ok' };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      // 只读令牌失效就删掉，下次 App 打开会重新签发一枚
      if (usingWidgetToken) await clearWidgetToken();
      return { summary: cached, reason: cached ? 'ok' : 'expired' };
    }
    return { summary: cached, reason: cached ? 'ok' : 'offline' };
  }
}

/** 从本地镜像里捞完整对象：widget 的摘要只有渲染需要的字段，写操作需要整行 */
async function loadLocal(): Promise<{ tasks: Task[]; logs: HabitLog[]; exceptions: RecurException[] }> {
  const rows = await loadAll();
  const tasks: Task[] = [];
  const logs: HabitLog[] = [];
  const exceptions: RecurException[] = [];

  for (const row of rows) {
    if (row.deletedAt !== null) continue;
    if (row.tbl === 'task') {
      const parsed = taskSchema.safeParse({ ...row.payload, id: row.id, rev: row.rev, deletedAt: null });
      if (parsed.success) tasks.push(parsed.data);
    } else if (row.tbl === 'habit_log') {
      const parsed = habitLogSchema.safeParse({ ...row.payload, id: row.id, rev: row.rev, deletedAt: null });
      if (parsed.success) logs.push(parsed.data);
    } else if (row.tbl === 'recur_exception') {
      const parsed = recurExceptionSchema.safeParse({ ...row.payload, id: row.id, rev: row.rev, deletedAt: null });
      if (parsed.success) exceptions.push(parsed.data);
    }
  }

  return { tasks, logs, exceptions };
}

/**
 * 在桌面上勾完成。
 *
 * 返回值是**更新后的缓存**，调用方拿它立刻重绘 —— 这就是"勾完立刻消失、
 * 下一条补上来"的实现：不需要等网络，也不需要重新拉接口。
 * 真正的同步交给调用方在后面 flushOutbox()。
 */
export async function toggleTaskFromWidget(taskId: string): Promise<WidgetSummary | null> {
  const summary = await readCachedSummary();
  if (!summary) return null;

  const { tasks, exceptions } = await loadLocal();
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return null;

  await toggleTaskComplete(task, exceptions.filter((item) => item.seriesId === taskId));

  // 已完成的那条从桌面移除；接口本来就多给了一条（4 条只画 3 条），
  // 所以移除后剩下的正好补满，不需要额外请求。
  const next: WidgetSummary = {
    ...summary,
    tasks: summary.tasks.filter((item) => item.id !== taskId),
    openCount: Math.max(0, summary.openCount - 1),
  };
  await writeCachedSummary(next);
  return next;
}

/**
 * 在桌面上打卡。
 *
 * **只打不撤**（docs/11 §2 的产品决定）：再点一次不会取消，想删得进 App。
 * 理由是桌面上误触的概率远高于 App 内，而"点两下把昨天补的卡撤掉"这种事故
 * 在 widget 上没有撤销提示可给。
 */
export async function checkHabitFromWidget(habitId: string): Promise<WidgetSummary | null> {
  const summary = await readCachedSummary();
  if (!summary) return null;

  const habit = summary.habits.find((item) => item.id === habitId);
  if (!habit) return null;
  // 已达标直接返回：再点会把 value 越加越大（8 杯水点成 9 杯），
  // 而"只打不撤"的产品决定意味着没有退回的路
  if (habit.doneToday) return summary;

  const today = localTodayKey();
  const logId = habitLogId(habitId, today);
  const { logs } = await loadLocal();
  const existing = logs.find((item) => item.id === logId) ?? null;

  const written = await writeHabitCheck(habitId, today, existing, 1);

  // 达标与否必须用**刚写进去的值**重新判，不能想当然设成 true。
  // 计数型目标 8 杯水，点一下只到 1/8，这时候打勾就是在撒谎 ——
  // 而谎话会在用户打开 App 看到 1/8 时当场穿帮，表现为"小组件说完成了，App 说没有"。
  const nextValue = written.log?.value ?? 0;
  const nowDone = nextValue >= habit.target;
  // 只有"此刻首次达标"才让连续天数 +1；没达标就一点不动
  const nextStreak = nowDone && !habit.doneToday ? habit.streak + 1 : habit.streak;

  const next: WidgetSummary = {
    ...summary,
    habits: summary.habits.map((item) =>
      item.id === habitId
        ? { ...item, value: nextValue, doneToday: nowDone, streak: nextStreak }
        : item,
    ),
    maxStreak: Math.max(summary.maxStreak, nextStreak),
  };
  await writeCachedSummary(next);
  return next;
}
