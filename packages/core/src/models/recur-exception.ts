import { z } from 'zod';

/**
 * 重复例外：独立实体，不塞进母体的 JSON 列。
 *
 * 这是 docs/03 §4.4 的结论，理由是同步：例外要单独参与增量、单独记冲突、单独软删。
 * 塞进 JSON 之后，改一次例外就会抬高母体的 rev，其他设备看到的是一整行"变了"，
 * 合并时无法判断到底动了哪个字段，于是每次都报假冲突。
 *
 * `(seriesId, originalStart)` 是天然唯一键——同一系列的同一次只会有一个结论
 * （要么被跳过，要么被改写），不需要再多一个序号。
 */

export const recurExceptionKindSchema = z.enum(['override', 'deleted']);
export type RecurExceptionKind = z.infer<typeof recurExceptionKindSchema>;

const idLike = z.string().min(1).max(26);
const epochMs = z.number().int().nonnegative();

export const recurExceptionSchema = z.object({
  id: idLike,
  seriesId: idLike,
  /** 该次在原系列中的原定开始，例外的定位键 */
  originalStart: epochMs,
  kind: recurExceptionKindSchema,
  /** 改写后的开始/结束；null 表示沿用母体推算出来的值 */
  overrideStart: epochMs.nullable(),
  overrideEnd: epochMs.nullable(),
  overrideTitle: z.string().max(512).nullable(),
  /** 其余被改字段的稀疏覆盖，键名与 Task 模型一致 */
  payload: z.record(z.unknown()).nullable(),
  createdAt: epochMs,
  updatedAt: epochMs,
  deletedAt: epochMs.nullable(),
  rev: z.number().int().min(1),
});

export type RecurException = z.infer<typeof recurExceptionSchema>;

export function exceptionKey(seriesId: string, originalStart: number): string {
  return `${seriesId}@${originalStart}`;
}
