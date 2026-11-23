import { useCallback, useEffect, useRef, useState } from 'react';

interface UndoActions {
  /** 点「撤销」时执行 */
  undo: () => Promise<void> | void;
  /** 窗口到期（或出现下一条撤销）时执行：真正落地 */
  commit: () => Promise<void> | void;
}

export interface UndoEntry {
  key: number;
  message: string;
  ttlMs: number;
}

interface Pending extends UndoActions {
  timer: number;
}

/**
 * 5 秒撤销窗口。
 *
 * 语义刻意做成「先执行，再给反悔机会」而不是「确认后才执行」：
 * 删除立刻生效（列表马上少一行，符合直觉），撤销窗口结束时才物理删除。
 * 如果中途关掉页面，purgeExpired 会在下次启动时补刀，所以不会留下永远删不掉的幽灵行。
 *
 * 同一时刻只保留一条撤销：第二次删除会把第一条立即落地——
 * 否则用户会以为"撤销"能一次撤回好几步，实际只能撤最后一步，那才是欺骗。
 */
export function useUndo(ttlMs = 5000) {
  const [entry, setEntry] = useState<UndoEntry | null>(null);
  const pending = useRef<Pending | null>(null);

  const settle = useCallback(async () => {
    const current = pending.current;
    if (!current) return;
    window.clearTimeout(current.timer);
    pending.current = null;
    setEntry(null);
    await current.commit();
  }, []);

  const push = useCallback(
    async (message: string, actions: UndoActions) => {
      if (pending.current) {
        // 上一条立即落地，不叠加
        window.clearTimeout(pending.current.timer);
        const previous = pending.current;
        pending.current = null;
        await previous.commit();
      }

      const timer = window.setTimeout(() => {
        const current = pending.current;
        pending.current = null;
        setEntry(null);
        if (current) void current.commit();
      }, ttlMs);

      pending.current = { ...actions, timer };
      setEntry({ key: Date.now(), message, ttlMs });
    },
    [ttlMs],
  );

  const undo = useCallback(async () => {
    const current = pending.current;
    if (!current) return;
    window.clearTimeout(current.timer);
    pending.current = null;
    setEntry(null);
    await current.undo();
  }, []);

  // 切视图导致卸载时，把还没到期的操作落地，避免"撤销条消失了但任务还在"
  useEffect(() => {
    return () => {
      const current = pending.current;
      if (!current) return;
      window.clearTimeout(current.timer);
      pending.current = null;
      void current.commit();
    };
  }, []);

  return { entry, push, undo, settle };
}
