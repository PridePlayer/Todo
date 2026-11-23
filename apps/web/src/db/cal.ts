import type { CalEvent } from '@grid/core';
import { db } from './dexie';
import { enqueueTableDelete, enqueueTableUpdate } from './repo';

/**
 * Outlook 事件镜像的本地写入路径。
 *
 * 与 repo.ts 分开的原因：task 的写入要算象限、路径、深度、标签合并，
 * 而事件只有"标题 / 起止 / 全天"四个可写字段，混在一个类里会让那些校验也套到事件上。
 *
 * 纪律：**先写本地再入队**。反过来做的话，队列先被 flush 时服务端拿到的是一份
 * 还没落到本地的改动，回包又把它写回来，界面会闪一下。
 */

export interface CalEventPatch {
  subject?: string;
  startAt?: number;
  endAt?: number;
  allDay?: boolean;
}

const WRITABLE = ['subject', 'startAt', 'endAt', 'allDay'] as const;

export async function patchCalEvent(id: string, patch: CalEventPatch): Promise<void> {
  const row = await db.events.get(id);
  if (!row || row.deletedAt !== null) return;

  const fields: Record<string, unknown> = {};
  const base: Record<string, unknown> = {};
  for (const key of WRITABLE) {
    const next = patch[key];
    if (next === undefined) continue;
    const current = row[key];
    if (current === next) continue;
    fields[key] = next;
    base[key] = current;
  }
  if (Object.keys(fields).length === 0) return;

  const now = Date.now();
  await db.events.put({
    ...row,
    ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
    ...(patch.startAt !== undefined ? { startAt: patch.startAt } : {}),
    ...(patch.endAt !== undefined ? { endAt: patch.endAt } : {}),
    ...(patch.allDay !== undefined ? { allDay: patch.allDay } : {}),
    syncState: 'pending_push',
    updatedAt: now,
  });
  await enqueueTableUpdate('cal_event', id, fields, base, row.rev);
}

export async function deleteCalEvent(id: string): Promise<void> {
  const row = await db.events.get(id);
  if (!row || row.deletedAt !== null) return;
  const now = Date.now();
  await db.events.put({ ...row, deletedAt: now, updatedAt: now, rev: row.rev });
  await enqueueTableDelete('cal_event', id, row.rev);
}

/** 事件的"可写"判定：重复事件只读（P0），只读日历上的事件也只读 */
export function eventReadOnly(event: CalEvent, sourceCanEdit: boolean): boolean {
  return event.isRecurring || !sourceCanEdit || event.syncState === 'readonly';
}
