import {
  calEventSchema,
  calendarSourceSchema,
  habitLogSchema,
  habitSchema,
  listSchema,
  quadrantOf,
  recurExceptionSchema,
  tagSchema,
  taskSchema,
  ulid,
  type CalEvent,
  type Habit,
  type HabitLog,
  type Hlc,
  type SyncOp,
  type Tag,
  type Task,
  type TaskList,
} from '@grid/core';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createApiClient, ApiError } from '@grid/core';
import { currentAuth, clearAuth, ensureDeviceId, loadAuth, rememberedEmail, saveAuth, type AuthState } from './auth';
import { currentApiBase, loadApiBase } from './config';
import {
  applyChanges,
  bumpRev,
  dropOps,
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
}

const EMPTY: Snapshot = { tasks: [], lists: [], tags: [], habits: [], logs: [], events: [] };

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
  toggleTask: (id: string) => Promise<void>;
  createTask: (input: NewTaskInput) => Promise<string>;
  patchTask: (id: string, patch: Record<string, unknown>) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  ensureTag: (name: string) => Promise<Tag>;
  checkHabit: (habitId: string, logDate: string, delta: number) => Promise<void>;
  changeApiBase: (value: string) => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

/** HLC：墙钟前进则计数清零，否则累加，保证同一毫秒内多次改动也有全序 */
let hlcWall = 0;
let hlcCounter = 0;
function nextHlc(device: string): Hlc {
  const now = Date.now();
  if (now > hlcWall) {
    hlcWall = now;
    hlcCounter = 0;
  } else {
    hlcCounter += 1;
  }
  return { wall: hlcWall, counter: hlcCounter, device };
}

function api() {
  return createApiClient({
    baseUrl: `${currentApiBase()}/api`,
    // 每次现取：令牌静默轮换后不需要重启 App
    authToken: () => currentAuth()?.token ?? null,
  });
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

  // 未使用的 schema 在这里保持引用：它们对应表已在 SYNC_TABLES 中，
  // 解析器缺一个就会静默丢一类数据，留 TODO 比留空白好排查
  void recurExceptionSchema;
  void calendarSourceSchema;

  return { tasks, lists, tags, habits, logs, events };
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

  // 同一时刻只允许一个 flush 在飞：并发 push 会让同一条 op 被提交两次，
  // 服务端虽然有 opId 幂等，但客户端两边的 rev 更新会互相覆盖
  const flushing = useRef(false);

  const reload = useCallback(async () => {
    const rows = await loadAll();
    setSnapshot(decode(rows));
    const ops = await loadOps();
    setPending(ops.length);
  }, []);

  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      const ops = await loadOps();
      if (ops.length === 0) return;
      const device = await ensureDeviceId();
      const res = await api().syncPush({ deviceId: device, ops: ops.map((o) => o.body) });
      const done: string[] = [];
      for (const result of res.results) {
        if (result.status === 'applied' || result.status === 'duplicate' || result.status === 'conflict') {
          done.push(result.opId);
          const op = ops.find((o) => o.opId === result.opId);
          // 服务端给了新 rev 就跟上，否则下一次 push 的 baseRev 永远是旧的 → 一直被当成冲突
          if (op && typeof result.rev === 'number' && result.rev > 0) {
            await bumpRev(op.body.table, op.body.id, result.rev);
          }
        } else if (result.status === 'rejected') {
          // 被拒的不能留：留着每次同步都重试，且永远失败
          done.push(result.opId);
          setLastError(result.reason ?? '有一条改动被服务端拒绝');
        }
      }
      await dropOps(done);
    } finally {
      flushing.current = false;
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
  }, [flush, reload]);

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
    setAuth(null);
    setSnapshot(EMPTY);
    setLastSyncAt(null);
    setPending(0);
    setPhase('idle');
  }, []);

  const toggleTask = useCallback(async (id: string) => {
    const task = snapshot.tasks.find((t) => t.id === id);
    if (!task) return;
    const nextCompleted = task.completedAt === null ? Date.now() : null;
    const device = await ensureDeviceId();
    const payload = { ...task, completedAt: nextCompleted };
    // rev 不动：本地 rev 必须始终等于"服务端已知版本"，
    // 自己 +1 会让下一次 push 的 baseRev 高于服务端，永远冲突
    await putRow('task', id, task.rev, payload as unknown as Record<string, unknown>);
    await queueOp({
      opId: ulid(),
      table: 'task',
      action: 'update',
      id,
      baseRev: task.rev,
      fields: { completedAt: nextCompleted },
      base: { completedAt: task.completedAt },
      hlc: nextHlc(device),
    });
    setSnapshot((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) => (t.id === id ? { ...t, completedAt: nextCompleted } : t)),
    }));
    setPending((n) => n + 1);
    void refresh();
  }, [refresh, snapshot.tasks]);

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
      location: null,
      tagIds: input.tagIds ?? [],
      completedAt: null,
      archivedAt: null,
      sortOrder: -now,
      rrule: input.rrule ?? null,
      remindAt: null,
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
   * 计数型是"加上去"而不是"设成某个值"，所以必须读当前值再算，
   * 并且主键用 core 的 habitLogId(habitId, logDate) —— 确定性主键让
   * "两台设备同一天各点一次"撞成同一行，服务端才能按 max 合并。
   */
  const checkHabit = useCallback(
    async (habitId: string, logDate: string, delta: number) => {
      const { habitLogId } = await import('@grid/core');
      const id = habitLogId(habitId, logDate);
      const existing = snapshot.logs.find((log) => log.id === id) ?? null;
      const device = await ensureDeviceId();
      const now = Date.now();
      const nextValue = Math.max(0, (existing?.value ?? 0) + delta);
      const next: HabitLog = {
        id,
        habitId,
        logDate,
        value: nextValue,
        backfilled: false,
        note: existing?.note ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        deletedAt: null,
        rev: existing?.rev ?? 1,
      };
      await putRow('habit_log', id, existing?.rev ?? 1, next as unknown as Record<string, unknown>);
      await queueOp({
        opId: ulid(),
        table: 'habit_log',
        action: existing ? 'update' : 'create',
        id,
        baseRev: existing?.rev ?? 0,
        fields: next as unknown as Record<string, unknown>,
        hlc: nextHlc(device),
      });
      setSnapshot((prev) => ({
        ...prev,
        logs: existing ? prev.logs.map((l) => (l.id === id ? next : l)) : [...prev.logs, next],
      }));
      setPending((n) => n + 1);
      void refresh();
    },
    [refresh, snapshot.logs],
  );

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
      deleteTask,
      ensureTag,
      checkHabit,
      changeApiBase,
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
      deleteTask,
      ensureTag,
      checkHabit,
      changeApiBase,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}
