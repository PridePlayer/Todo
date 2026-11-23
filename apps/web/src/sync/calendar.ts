import type { CalendarStatus } from '@grid/core';
import { api } from '../api';
import { db } from '../db/dexie';

/**
 * 日历相关的"本地优先"包装。
 *
 * 开关日历源这件事必须立刻看到结果：勾掉「显示」之后日历上还挂着那些块，
 * 用户会以为没点中，于是再点一次，把状态又切回去。所以先写本地，再发请求，
 * 失败了再回滚——宁可闪一下，也不要"看起来没反应"。
 */

export async function loadCalendarStatus(): Promise<CalendarStatus | null> {
  try {
    return await api.calendarStatus();
  } catch {
    return null;
  }
}

export async function patchSourceEverywhere(
  id: string,
  patch: { isVisible?: boolean; isSynced?: boolean },
): Promise<void> {
  const before = await db.sources.get(id);
  if (before) await db.sources.put({ ...before, ...patch });
  try {
    await api.calendarPatchSource(id, patch);
  } catch {
    if (before) await db.sources.put(before);
  }
}
