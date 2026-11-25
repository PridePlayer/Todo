import {
  calEventSchema,
  calendarSourceSchema,
  habitLogSchema,
  habitSchema,
  listSchema,
  nextOccurrencePatch,
  quadrantOf,
  recurExceptionSchema,
  tagSchema,
  taskSchema,
  ulid,
  type CalEvent,
  type Habit,
  type HabitLog,
  type RecurException,
  type SyncOp,
  type Tag,
  type Task,
  type TaskList,
} from '@grid/core';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '@grid/core';
import { currentAuth, clearAuth, ensureDeviceId, loadAuth, rememberedEmail, saveAuth, type AuthState } from './auth';
import { makeApiClient } from './api';
import { checkHabit as writeHabitCheck, toggleTaskComplete } from './domain/toggle';
import { nextHlc } from './hlc';
import { cancelAllReminders, rescheduleReminders } from './notify/schedule';
import { publishWidgetToHomeScreen } from './widget/publish';
import { readWidgetToken, saveWidgetToken } from './widget/data';
import { currentApiBase, loadApiBase } from './config';
import { flushOutbox } from './sync/push';
import {
  applyChanges,
  getMeta,
  loadAll,
  loadOps,
  openDb,
  putRow,
  queueOp,
  setMeta,
  softDeleteRow,
  wipe,
  type DocRow,
} from './db/local';

export interface Snapshot {
  tasks: Task[];
  lists: TaskList[];
  tags: Tag[];
  habits: Habit[];
  logs: HabitLog[];
  events: CalEvent[];
  /** 重复事件的"某一次被改/被删"。日历展开时必须带上，否则删掉的那次还会显示 */
  exceptions: RecurException[];
}

const EMPTY: Snapshot = { tasks: [], lists: [], tags: [], habits: [], logs: [], events: [], exceptions: [] };

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'error';

/**
 * 新建任务的入参。
 *
 * 除了 title 全是可选 —— 这是"新建不强制分类"的落地：手机上敲一句话回车就存了，
 * 象限、日期、重复都留到详情页再补。默认落到 04（不重要不紧急），
 * 也就是 GTD 的"收件箱"位置，之后在四象限里归类。
 */
export interface NewTaskInput {
  title: string;
  quadrant?: 1 | 2 | 3 | 4;
  dueDate?: string | null;
  startAt?: number | null;
  rrule?: string | null;
  tagIds?: string[];
  note?: string | null;
  listId?: string;
  location?: string | null;
  remindLeadMinutes?: number | null;
}

interface AppState {
  ready: boolean;
  auth: AuthState | null;
  snapshot: Snapshot;
  phase: SyncPhase;
  pending: number;
  lastSyncAt: number | null;
  lastError: string | null;
  remembered: string | null;
  apiBase: string;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  /** 清空本地镜像并全量重拉：修"两端数字对不上且不自愈" */
  forceResync: () => Promise<void>;
  toggleTask: (id: string) => Promise<void>;
  createTask: (input: NewTaskInput) => Promise<string>;
  patchTask: (id: string, patch: Record<string, unknown>) => Promise<void>;
  patchHabit: (id: string, patch: Partial<Habit>) => Promise<void>;
  createHabit: (input: {
    name: string;
    type: 'check' | 'count' | 'duration';
    target: number;
    unit: string | null;
    daysOfWeek: number[];
  }) => Promise<void>;
  archiveHabit: (id: string, archived: boolean) => Promise<void>;
  deleteHabit: (id: string) => Promise<void>;
  /** 跳过重复任务的某一次（写一条 deleted 例外，该次不再出现） */
  skipOccurrence: (seriesId: string, originalStart: number) => Promise<void>;
  flash: string | null;
  showFlash: (text: string) => void;
  /** 把一条日程写进 Outlook。未连接时返回 ok:false，不抛错 */
  createCalendarEvent: (input: {
    title: string;
    startAt: number;
    endAt: number;
    location?: string | null;
  }) => Promise<{ ok: boolean; error?: string }>;
  deleteTask: (id: string) => Promise<void>;
  ensureTag: (name: string) => Promise<Tag>;
  checkHabit: (habitId: string, logDate: string, delta: number) => Promise<void>;
  changeApiBase: (value: string) => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

function api() {
  return makeApiClient();
}

function decode(rows: DocRow[]): Snapshot {
  const live = rows.filter((row) => row.deletedAt === null);
  const pick = (tbl: DocRow['tbl']) => live.filter((row) => row.tbl === tbl);

  const tasks: Task[] = [];
  for (const row of pick('task')) {
    const parsed = taskSchema.safeParse({ ...row.payload, id: row.id, rev: row.rev, deletedAt: null });
    if (parsed.success) tasks.push(parsed.data);
  }

  const lists: TaskList[] = [];
  for (const row of pick('list')) {
    const parsed = listSchema.safeParse({ ...row.payload, id: row.id });
    if (parsed.success) lists.push(parsed.data);
  }
  // 收件箱是兜底：服务端没给之前，任务也得有个归属
  if (!lists.some((l) => l.id === 'list-inbox')) {
    lists.unshift({ id: 'list-inbox', name: '收件箱', sortOrder: 0 });
  }
  lists.sort((a, b) => a.sortOrder - b.sortOrder);

  const tags: Tag[] = [];
  for (const row of pick('tag')) {
    const parsed = tagSchema.safeParse({ ...row.payload, id: row.id, rev: row.rev, deletedAt: null });
    if (parsed.success) tags.push(parsed.data);
  }

  const habits: Habit[] = [];
  for (const row of pick('habit')) {
    const parsed = habitSchema.safeParse({ ...row.payload, id: row.id, rev: row.rev, deletedAt: null });
    if (parsed.success) habits.push(parsed.data);
  }
  habits.sort((a, b) => a.sortOrder - b.sortOrder);

  const logs: HabitLog[] = [];
  for (const row of pick('habit_log')) {
    const parsed = habitLogSchema.safeParse({ ...row.payload, id: row.id, rev: row.rev, deletedAt: null });
    if (parsed.success) logs.push(parsed.data);
  }

  const events: CalEvent[] = [];
  for (const row of pick('cal_event')) {
    const parsed = calEventSchema.safeParse({ ...row.payload, id: row.id, rev: row.rev, deletedAt: null });
    if (parsed.success) events.push(parsed.data);
  }

  const exceptions: RecurException[] = [];
  for (const row of pick('recur_exception')) {
    const parsed = recurExceptionSchema.safeParse({ ...row.payload, id: row.id, rev: row.rev, deletedAt: null });
    if (parsed.success) exceptions.push(parsed.data);
  }

  // calendar_source 现在只用于设置页（日历源开关），先不解析进 snapshot
  void calendarSourceSchema;

  return { tasks, lists, tags, habits, logs, events, exceptions };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [phase, setPhase] = useState<SyncPhase>('idle');
  const [pending, setPending] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [remembered, setRemembered] = useState<string | null>(null);
  const [apiBase, setApiBase] = useState(currentApiBase());

  // 并发锁现在在 ./sync/push.ts 的模块级（widget 与 App 共享同一个锁）

  /**
   * 全局一次性提示。
   *
   * 为什么放在 store 而不是各页面：勾选操作的反馈在今日页、列表页、四象限
   * 都要有，重复实现三遍必然漏；而且失败信息（异常被吞）只有集中处理
   * 才不会又变成"点了没反应"。
   */
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showFlash = useCallback((text: string) => {
    setFlash(text);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 2400);
  }, []);

  const reload = useCallback(async () => {
    const rows = await loadAll();
    const next = decode(rows);
    setSnapshot(next);
    const ops = await loadOps();
    setPending(ops.length);
    // 顺手把桌面小组件刷成最新：updatePeriodMillis 的下限是 30 分钟，
    // 不主动推的话"App 里刚勾完、桌面还挂着"会被当成 bug
    void publishWidgetToHomeScreen({ tasks: next.tasks, habits: next.habits, logs: next.logs });
    // 提醒跟着数据重排。内部有指纹去重：数据没变直接返回，不会每 30 秒调一次原生接口
    void rescheduleReminders(next.tasks, next.habits);
  }, []);

  const flush = useCallback(async () => {
    // 推送逻辑搬到了 ./sync/push.ts —— 桌面小组件的 headless 任务也要用它，
    // 而那里没有 React 上下文。错误仍然往外抛，refresh 要靠它区分离线与真错误。
    const outcome = await flushOutbox();
    if (outcome.rejected.length > 0) {
      setLastError(outcome.rejected[0]!.reason);
    }
  }, []);

  /**
   * 小组件只读令牌的续签。
   *
   * 为什么放在 refresh 里而不是登录时一次：令牌 90 天过期，而 App 可能连续几个月
   * 不被"重新登录"（设备令牌 180 天，临期还会静默轮换）。只在登录时签发的话，
   * 第 91 天桌面上的 widget 会突然变成"登录已过期"，而用户什么都没做错。
   *
   * 快到期才真发请求，其余时候只读一次 sqlite 就返回。
   */
  const ensureWidgetToken = useCallback(async () => {
    if (!currentAuth()) return;
    try {
      const existing = await readWidgetToken();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (existing && existing.expiresAt - Date.now() > sevenDays) return;
      const issued = await api().createWidgetToken();
      await saveWidgetToken(issued);
    } catch (err) {
      // 签不出令牌不该让同步失败：widget 会退回只读缓存，而 App 本身一切正常
      console.warn('[widget] token issue failed', err);
    }
  }, []);

  const refresh = useCallback(async () => {
    setPhase('syncing');
    setLastError(null);
    try {
      await flush();

      let cursor = Number((await getMeta('cursor')) ?? '0');
      if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
      let guard = 0;
      for (;;) {
        const res = await api().syncPull({ cursor, limit: 200 });
        if (res.resyncRequired) {
          // 游标早于最早墓碑：只能全量重建，否则本地会永远缺一段
          await wipe();
          cursor = 0;
          continue;
        }
        await applyChanges(res.changes);
        cursor = res.nextCursor;
        await setMeta('cursor', String(cursor));
        if (!res.hasMore) break;
        guard += 1;
        if (guard > 200) break;
      }

      await reload();
      setLastSyncAt(Date.now());
      setPhase('idle');
      void ensureWidgetToken();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await clearAuth();
        setAuth(null);
        setPhase('idle');
        return;
      }
      // 网络不通时不要清空本地：离线可读是核心能力，不是降级
      setPhase(err instanceof ApiError && err.code === 'network_error' ? 'offline' : 'error');
      setLastError(err instanceof Error ? err.message : '同步失败');
      await reload();
    }
  }, [flush, reload, ensureWidgetToken]);

  // ── 启动 ──
  useEffect(() => {
    let alive = true;
    void (async () => {
      await loadApiBase();
      await ensureDeviceId();
      await openDb();
      const saved = await loadAuth();
      const email = await rememberedEmail();
      if (!alive) return;
      setApiBase(currentApiBase());
      setAuth(saved);
      setRemembered(email);
      await reload();
      setReady(true);
      if (saved) void refresh();
    })();
    return () => {
      alive = false;
    };
  }, [reload, refresh]);

  const signIn = useCallback(async (email: string, password: string) => {
    const device = await ensureDeviceId();
    const res = await api().deviceLogin(email.trim().toLowerCase(), password, `Android ${device.slice(-6)}`);
    const next: AuthState = {
      token: res.device.token,
      userId: res.user.id,
      email: res.user.email,
      expiresAt: res.device.expiresAt,
    };
    // 换了账号就把旧账号的镜像清掉，否则会看到上一个账号的任务
    const previous = currentAuth();
    if (previous && previous.userId !== next.userId) {
      await wipe();
    }
    await saveAuth(next);
    setAuth(next);
    setRemembered(next.email);
    await refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await clearAuth();
    await wipe();
    // 不清提醒的话，换账号之后还会收到上一个人的待办标题 —— 这是最不该出现的泄露
    await cancelAllReminders();
    setAuth(null);
    setSnapshot(EMPTY);
    setLastSyncAt(null);
    setPending(0);
    setPhase('idle');
  }, []);

  const toggleTask = useCallback(async (id: string) => {
   const task = snapshot.tasks.find((t) => t.id === id);
   if (!task) return;
   try {
    // 语义（含重复任务推进）在 ./domain/toggle.ts，与桌面小组件共用同一份
    const result = await toggleTaskComplete(task, snapshot.exceptions);
    setSnapshot((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) => (t.id === id ? result.task : t)),
    }));
    setPending((n) => n + 1);
    if (result.advanced) showFlash(result.message);
    void refresh();
   } catch (err) {
     // 以前这里是 void Promise，异常被静默吞掉，界面表现就是"点了没反应"
     console.warn('[toggle]', err);
     showFlash(`操作失败：${err instanceof Error ? err.message : String(err)}`);
   }
  }, [refresh, snapshot.tasks, snapshot.exceptions, showFlash]);

  const createTask = useCallback(async (input: NewTaskInput) => {
    const trimmed = input.title.trim();
    if (!trimmed) return '';
    const device = await ensureDeviceId();
    const now = Date.now();
    const id = ulid();
    const quadrant = input.quadrant ?? 4;
    const bits = 4 - quadrant;
    const task: Task = {
      id,
      listId: input.listId ?? 'list-inbox',
      parentId: null,
      path: `${id}/`,
      depth: 0,
      title: trimmed,
      note: input.note ?? null,
      quadrant,
      // important/urgent 是唯一真源，quadrant 是派生值；两者必须同时对上，
      // 否则四象限里按 quadrant 查到的行，详情页的开关会显示成另一组状态
      important: (bits & 2) !== 0,
      urgent: (bits & 1) !== 0,
      priority: 0,
      dueDate: input.dueDate ?? null,
      startAt: input.startAt ?? null,
      endAt: null,
      allDay: input.startAt == null,
      location: input.location ?? null,
      tagIds: input.tagIds ?? [],
      completedAt: null,
      archivedAt: null,
      sortOrder: -now,
      rrule: input.rrule ?? null,
      remindAt: null,
      remindLeadMinutes: input.remindLeadMinutes ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      rev: 1,
    };
    await putRow('task', id, 1, task as unknown as Record<string, unknown>);
    await queueOp({
      opId: ulid(),
      table: 'task',
      action: 'create',
      id,
      baseRev: 0,
      fields: task as unknown as Record<string, unknown>,
      hlc: nextHlc(device),
    });
    setSnapshot((prev) => ({ ...prev, tasks: [...prev.tasks, task] }));
    setPending((n) => n + 1);
    void refresh();
    return id;
  }, [refresh]);

  /**
   * 局部更新。
   *
   * `base` 必须带上每个字段改动前的值 —— 服务端靠它区分"远端到底动没动过这个字段"。
   * 不带的话，两台设备改不同字段会被误判成冲突，界面上会出现一堆假的"冲突待决"。
   */
  const patchTask = useCallback(async (id: string, patch: Record<string, unknown>) => {
    const task = snapshot.tasks.find((t) => t.id === id);
    if (!task) return;
    const device = await ensureDeviceId();
    const next: Task = { ...task, ...patch, updatedAt: Date.now() } as Task;

    const fields: Record<string, unknown> = { ...patch };
    const base: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      base[key] = (task as unknown as Record<string, unknown>)[key];
    }

    // 象限是派生值：只改开关不同步 quadrant，列表按 quadrant 排序就会错位
    if (patch.important !== undefined || patch.urgent !== undefined) {
      const derived = quadrantOf(next.important, next.urgent);
      next.quadrant = derived;
      fields.quadrant = derived;
      base.quadrant = task.quadrant;
    }

    await putRow('task', id, task.rev, next as unknown as Record<string, unknown>);
    await queueOp({
      opId: ulid(),
      table: 'task',
      action: 'update',
      id,
      baseRev: task.rev,
      fields,
      base,
      hlc: nextHlc(device),
    });
    setSnapshot((prev) => ({ ...prev, tasks: prev.tasks.map((t) => (t.id === id ? next : t)) }));
    setPending((n) => n + 1);
    void refresh();
  }, [refresh, snapshot.tasks]);

  const deleteTask = useCallback(async (id: string) => {
    const task = snapshot.tasks.find((t) => t.id === id);
    if (!task) return;
    const device = await ensureDeviceId();
    const now = Date.now();
    await softDeleteRow('task', id, now);
    await queueOp({
      opId: ulid(),
      table: 'task',
      action: 'delete',
      id,
      baseRev: task.rev,
      fields: {},
      hlc: nextHlc(device),
    });
    setSnapshot((prev) => ({ ...prev, tasks: prev.tasks.filter((t) => t.id !== id) }));
    setPending((n) => n + 1);
    void refresh();
  }, [refresh, snapshot.tasks]);

  /** 改习惯（目标值、排期、名称）。与 patchTask 同一套字段掩码语义 */
  const patchHabit = useCallback(async (id: string, patch: Partial<Habit>) => {
    const habit = snapshot.habits.find((h) => h.id === id);
    if (!habit) return;
    const device = await ensureDeviceId();
    const next: Habit = { ...habit, ...patch, updatedAt: Date.now() };
    const fields: Record<string, unknown> = { ...patch };
    const base: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      base[key] = (habit as unknown as Record<string, unknown>)[key];
    }
    await putRow('habit', id, habit.rev, next as unknown as Record<string, unknown>);
    await queueOp({
      opId: ulid(),
      table: 'habit',
      action: 'update',
      id,
      baseRev: habit.rev,
      fields,
      base,
      hlc: nextHlc(device),
    });
    setSnapshot((prev) => ({ ...prev, habits: prev.habits.map((h) => (h.id === id ? next : h)) }));
    setPending((n) => n + 1);
    void refresh();
  }, [refresh, snapshot.habits]);

  /**
   * 跳过重复任务的某一次。
   *
   * 语义是"这一次不要了"，不是"把母体删掉"：写一条 kind=deleted 的
   * recur_exception，展开时会被排除。与 Web 端 repo.skipOccurrence 同一套数据。
   */
  const skipOccurrence = useCallback(
    async (seriesId: string, originalStart: number) => {
      const already = snapshot.exceptions.some(
        (e) => e.seriesId === seriesId && e.originalStart === originalStart && e.kind === 'deleted',
      );
      if (already) return;
      const device = await ensureDeviceId();
      const now = Date.now();
      const id = ulid();
      const exc: RecurException = {
        id,
        seriesId,
        originalStart,
        kind: 'deleted',
        overrideStart: null,
        overrideEnd: null,
        overrideTitle: null,
        payload: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        rev: 1,
      };
      await putRow('recur_exception', id, 1, exc as unknown as Record<string, unknown>);
      await queueOp({
        opId: ulid(),
        table: 'recur_exception',
        action: 'create',
        id,
        baseRev: 0,
        fields: exc as unknown as Record<string, unknown>,
        hlc: nextHlc(device),
      });
      // 光写例外还不够：列表显示的是母体，不展开实例，
      // 例外只会影响 Web 的展开视图，手机上看不到任何变化。
      // 必须同时把母体推进到下一个重复日，用户才会真的"跳到下一次"。
      const task = snapshot.tasks.find((t) => t.id === seriesId);
      if (task && task.rrule !== null) {
        const patch = nextOccurrencePatch(task, [...snapshot.exceptions, exc], now);
        if (patch !== null) {
          const next: Task = { ...task, ...patch, updatedAt: now };
          await putRow('task', task.id, task.rev, next as unknown as Record<string, unknown>);
          await queueOp({
            opId: ulid(),
            table: 'task',
            action: 'update',
            id: task.id,
            baseRev: task.rev,
            fields: patch as unknown as Record<string, unknown>,
            base: {
              dueDate: task.dueDate,
              startAt: task.startAt,
              endAt: task.endAt,
              allDay: task.allDay,
            },
            hlc: nextHlc(device),
          });
          setSnapshot((prev) => ({
            ...prev,
            exceptions: [...prev.exceptions, exc],
            tasks: prev.tasks.map((t) => (t.id === task.id ? next : t)),
          }));
          setPending((n) => n + 1);
          void refresh();
          return;
        }
      }

      setSnapshot((prev) => ({ ...prev, exceptions: [...prev.exceptions, exc] }));
      setPending((n) => n + 1);
      void refresh();
    },
    [refresh, snapshot.exceptions, snapshot.tasks],
  );

  const createHabit = useCallback(
    async (input: {
      name: string;
      type: 'check' | 'count' | 'duration';
      target: number;
      unit: string | null;
      daysOfWeek: number[];
      remindMinute?: number | null;
    }) => {
      const name = input.name.trim();
      if (name === '') return;
      const device = await ensureDeviceId();
      const now = Date.now();
      const habit: Habit = {
        id: ulid(),
        name,
        type: input.type,
        // 打勾型的目标恒为 1：它没有"部分完成"的概念
        target: input.type === 'check' ? 1 : Math.max(1, Math.round(input.target)),
        unit: input.type === 'check' ? null : input.unit,
        daysOfWeek: [...input.daysOfWeek].sort((a, b) => a - b),
        colorKey: 0,
        sortOrder: -now,
        remindMinute: input.remindMinute ?? null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        rev: 1,
      };
      await putRow('habit', habit.id, 1, habit as unknown as Record<string, unknown>);
      await queueOp({
        opId: ulid(),
        table: 'habit',
        action: 'create',
        id: habit.id,
        baseRev: 0,
        fields: habit as unknown as Record<string, unknown>,
        hlc: nextHlc(device),
      });
      setSnapshot((prev) => ({ ...prev, habits: [...prev.habits, habit] }));
      setPending((n) => n + 1);
      void refresh();
    },
    [refresh],
  );

  const archiveHabit = useCallback(async (id: string, archived: boolean) => {
    await patchHabit(id, { archivedAt: archived ? Date.now() : null });
  }, [patchHabit]);

  const deleteHabit = useCallback(async (id: string) => {
    const habit = snapshot.habits.find((h) => h.id === id);
    if (!habit) return;
    const device = await ensureDeviceId();
    const now = Date.now();
    await softDeleteRow('habit', id, now);
    await queueOp({
      opId: ulid(),
      table: 'habit',
      action: 'delete',
      id,
      baseRev: habit.rev,
      fields: {},
      hlc: nextHlc(device),
    });
    setSnapshot((prev) => ({ ...prev, habits: prev.habits.filter((h) => h.id !== id) }));
    setPending((n) => n + 1);
    void refresh();
  }, [refresh, snapshot.habits]);

  /**
   * 写一条日程到 Outlook。
   *
   * 不抛错是刻意的：日程能不能落到日历上，不该决定"这条待办建不建得成"。
   * 没连 Outlook、令牌过期、日历只读 —— 都退化成"只存本机"，由调用方提示。
   */
  const createCalendarEvent = useCallback(
    async (input: { title: string; startAt: number; endAt: number; location?: string | null }) => {
      try {
        await api().calendarCreateEvent({
          title: input.title,
          startAt: input.startAt,
          endAt: input.endAt,
          location: input.location ?? null,
        });
        return { ok: true };
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.status === 404) return { ok: false, error: '未连接 Outlook' };
          if (err.status === 409) return { ok: false, error: '没有可写入的日历' };
          return { ok: false, error: err.message };
        }
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [],
  );

  /**
   * 找标签或建标签。
   *
   * 先按名字在本地找（同名不同 id 会变成两个标签，界面上看就是重复项），
   * 找不到才新建。新建的标签要立刻入队，否则别的设备永远看不到它。
   */
  const ensureTag = useCallback(async (name: string): Promise<Tag> => {
    const trimmed = name.trim().replace(/^#/, '');
    const existing = snapshot.tags.find((tag) => tag.name === trimmed);
    if (existing) return existing;

    const device = await ensureDeviceId();
    const tag: Tag = { id: ulid(), name: trimmed, colorKey: 0 };
    // Tag 只有 id/name/colorKey 三个字段；服务端的 rev/时间戳不在客户端模型里，
    // 所以 fields 只带这三个，多带会被服务端当成未知列丢弃
    await putRow('tag', tag.id, 1, tag as unknown as Record<string, unknown>);
    await queueOp({
      opId: ulid(),
      table: 'tag',
      action: 'create',
      id: tag.id,
      baseRev: 0,
      fields: tag as unknown as Record<string, unknown>,
      hlc: nextHlc(device),
    });
    setSnapshot((prev) => ({ ...prev, tags: [...prev.tags, tag] }));
    setPending((n) => n + 1);
    return tag;
  }, [snapshot.tags]);

  /**
   * 打卡。
   *
   * 写入语义（确定性主键、算到 0 要删行）在 ./domain/toggle.ts，与桌面小组件共用。
   * 这里只负责把结果映射回界面状态。
   */
  const checkHabit = useCallback(
    async (habitId: string, logDate: string, delta: number) => {
      const { habitLogId } = await import('@grid/core');
      const id = habitLogId(habitId, logDate);
      const existing = snapshot.logs.find((log) => log.id === id) ?? null;
      const result = await writeHabitCheck(habitId, logDate, existing, delta);
      const settled = result.log;

      setSnapshot((prev) => ({
        ...prev,
        logs: settled
          ? existing
            ? prev.logs.map((log) => (log.id === id ? settled : log))
            : [...prev.logs, settled]
          : prev.logs.filter((log) => log.id !== id),
      }));
      setPending((n) => n + 1);
      void refresh();
    },
    [refresh, snapshot.logs],
  );

  /**
   * 强制重新拉取全部数据：清空本地镜像，把游标归零，再全量 pull 一遍。
   *
   * 解决的是"本地与服务器数字对不上、而且不会自愈"这一类问题：
   * 增量同步只拉 `change_seq > cursor` 的行，一旦某行的合并结果没被写回本地
   * （旧版本就是这样：只更新 rev、不更新字段），服务端那行又因为"最终值没变"
   * 而不产生新的 change_seq —— 这条数据就永远错位了，除非全量重拉。
   *
   * 顺序是刻意的：先 flush 把待推的东西推干净，推不出去就中止。
   * 反过来做会把还没上传的改动直接抹掉。
   */
  const forceResync = useCallback(async () => {
    await flushOutbox();
    await wipe();
    await setMeta('cursor', '0');
    setSnapshot(EMPTY);
    await refresh();
  }, [refresh]);

  const changeApiBase = useCallback(async (value: string) => {
    const { setApiBase: persist } = await import('./config');
    const next = await persist(value);
    setApiBase(next);
    // 换后端等于换数据源，本地镜像必须清空
    await wipe();
    setSnapshot(EMPTY);
    await refresh();
  }, [refresh]);

  const value = useMemo<AppState>(
    () => ({
      ready,
      auth,
      snapshot,
      phase,
      pending,
      lastSyncAt,
      lastError,
      remembered,
      apiBase,
      signIn,
      signOut,
      refresh,
      toggleTask,
      createTask,
      patchTask,
      patchHabit,
      createHabit,
      archiveHabit,
      deleteHabit,
      skipOccurrence,
      flash,
      showFlash,
      createCalendarEvent,
      deleteTask,
      ensureTag,
      checkHabit,
      changeApiBase,
      forceResync,
    }),
    [
      ready,
      auth,
      snapshot,
      phase,
      pending,
      lastSyncAt,
      lastError,
      remembered,
      apiBase,
      signIn,
      signOut,
      refresh,
      toggleTask,
      createTask,
      patchTask,
      patchHabit,
      createHabit,
      archiveHabit,
      deleteHabit,
      skipOccurrence,
      flash,
      showFlash,
      createCalendarEvent,
      deleteTask,
      ensureTag,
      checkHabit,
      changeApiBase,
      forceResync,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}
