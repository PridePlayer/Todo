import { HLC_MAX_SKEW_MS, type Hlc, type SyncConflict } from '@grid/core';
import { isKnownField, type SyncTableName } from './task-map.js';

/**
 * 字段级合并（docs/03 §7 的判定矩阵）。
 *
 * 输入是三个版本：`base`（本设备改动前）、`incoming`（本设备现在想写）、`current`（服务端现在）。
 * 三版本比较能区分两种情况，而只用 baseRev 是区分不出来的：
 *   - current[field] === base[field]  → 远端没动，本地直接生效（**不提示**）
 *   - current[field] !== base[field]  → 真的撞车，按字段语义裁决
 */

/** 四象限是一个不可拆的整体：拆开裁决会拼出"重要=false 但 quadrant=1"这种不可能状态 */
const QUADRANT_BLOCK = ['quadrant', 'important', 'urgent'] as const;

export interface MergeResult {
  /** 需要写回数据库的字段（camelCase） */
  applied: Record<string, unknown>;
  conflicts: SyncConflict[];
  /** 远端已删除 → 本次修改一律丢弃（删除优先） */
  suppressed: boolean;
}

/** 时钟保护：与本机（服务器）偏差超 5 分钟就改用服务器时间，防止某台设备时钟错乱导致永远获胜 */
export function normalizeHlc(hlc: Hlc, now: number): Hlc {
  if (Math.abs(hlc.wall - now) > HLC_MAX_SKEW_MS) {
    return { wall: now, counter: 0, device: hlc.device };
  }
  return hlc;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (JSON.stringify(a) === JSON.stringify(b)) return true;
  return false;
}

function unionTags(base: unknown, incoming: unknown, current: unknown): string[] {
  const asArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  // 并集：两边都加过的标签都保留。删除标签是显式的 remove 操作（M3），不靠"没带"推断
  return [...new Set([...asArray(base), ...asArray(current), ...asArray(incoming)])];
}

export function mergeFields(
  table: SyncTableName,
  params: {
    base: Record<string, unknown> | undefined;
    incoming: Record<string, unknown>;
    current: Record<string, unknown>;
    localNewer: boolean;
  },
): MergeResult {
  const { base, incoming, current, localNewer } = params;
  const applied: Record<string, unknown> = {};
  const conflicts: SyncConflict[] = [];

  // 删除优先：远端已经删了，本地的修改不再落地，但留下痕迹（可恢复）
  if (current.deletedAt !== null && current.deletedAt !== undefined) {
    for (const field of Object.keys(incoming)) {
      if (!isKnownField(table, field) || field === 'id') continue;
      if (sameValue(incoming[field], current[field])) continue;
      conflicts.push({ field, local: incoming[field] ?? null, remote: current[field] ?? null });
    }
    return { applied: {}, conflicts, suppressed: true };
  }

  const handled = new Set<string>();

  for (const field of Object.keys(incoming)) {
    if (handled.has(field)) continue;
    if (field === 'id' || !isKnownField(table, field)) continue;

    // ── 四象限整体裁决 ──
    if ((QUADRANT_BLOCK as readonly string[]).includes(field)) {
      for (const key of QUADRANT_BLOCK) handled.add(key);
      const localBlock: Record<string, unknown> = {};
      for (const key of QUADRANT_BLOCK) {
        if (incoming[key] !== undefined) localBlock[key] = incoming[key];
      }
      if (Object.keys(localBlock).length === 0) continue;

      const remoteUnchanged = QUADRANT_BLOCK.every(
        (key) => base === undefined || base[key] === undefined || sameValue(current[key], base[key]),
      );
      const differs = QUADRANT_BLOCK.some(
        (key) => localBlock[key] !== undefined && !sameValue(localBlock[key], current[key]),
      );
      if (!differs) continue;

      if (remoteUnchanged || localNewer) {
        Object.assign(applied, localBlock);
        if (!remoteUnchanged) {
          conflicts.push({
            field: 'quadrant',
            local: localBlock.quadrant ?? current.quadrant ?? null,
            remote: current.quadrant ?? null,
          });
        }
      } else {
        conflicts.push({
          field: 'quadrant',
          local: localBlock.quadrant ?? null,
          remote: current.quadrant ?? null,
        });
      }
      continue;
    }

    const remoteUnchanged = base === undefined || base[field] === undefined || sameValue(current[field], base[field]);
    if (remoteUnchanged) {
      applied[field] = incoming[field];
      continue;
    }

    // ── 标签取并集 ──
    if (field === 'tagIds') {
      applied[field] = unionTags(base?.tagIds, incoming[field], current[field]);
      continue;
    }

    // ── 完成状态：完成优先，防"被远端复活" ──
    if (field === 'completedAt') {
      const localDone = incoming[field] !== null && incoming[field] !== undefined;
      const remoteDone = current[field] !== null && current[field] !== undefined;
      if (localDone && !remoteDone) {
        applied[field] = incoming[field];
        conflicts.push({ field, local: incoming[field] ?? null, remote: current[field] ?? null });
      } else if (!localDone && remoteDone) {
        conflicts.push({ field, local: incoming[field] ?? null, remote: current[field] ?? null });
      } else if (localDone && remoteDone && localNewer) {
        applied[field] = incoming[field];
      }
      continue;
    }

    // ── 其余字段：HLC 定序 ──
    if (sameValue(incoming[field], current[field])) continue;
    if (localNewer) {
      applied[field] = incoming[field];
      conflicts.push({ field, local: incoming[field] ?? null, remote: current[field] ?? null });
    } else {
      conflicts.push({ field, local: incoming[field] ?? null, remote: current[field] ?? null });
    }
  }

  return { applied, conflicts, suppressed: false };
}
