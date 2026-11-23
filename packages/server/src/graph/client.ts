import { GraphError } from '../oauth/microsoft.js';

/**
 * Graph HTTP 客户端。
 *
 * 三件事必须集中在这里做，散到调用方就一定会漏：
 *   1. **并发上限 2**（docs/02 §6.5）。Graph 对单应用的并发很敏感，
 *      日历回填时几十条事件同时发请求会直接被 429。
 *   2. **429/5xx 退避重试**，优先遵从 Retry-After。
 *   3. **统一超时**。没有超时的一次挂起会占住并发槽，把后续所有同步一起堵死。
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const HTTP_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT = 2;
const MAX_RETRIES = 3;

/**
 * 让 Graph 直接用这个时区返回 dateTime。
 * 不设的话返回 UTC，而"全天事件"的日期会跟着时区漂一天（UTC 的 11-24T00:00 是
 * 上海时间的 11-24 08:00，看起来还好；反过来美国时区就会变成前一天）。
 */
export const CAL_TIME_ZONE = 'Asia/Shanghai';

let active = 0;
const waiters: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active += 1;
}

function release(): void {
  active -= 1;
  const next = waiters.shift();
  if (next) next();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GraphResponse<T> {
  json: T;
  etag: string | null;
  status: number;
}

interface RequestInitLite {
  method?: string;
  body?: unknown;
  /** If-Match：乐观并发。412 表示远端已变，调用方需重新取回再合并 */
  ifMatch?: string;
  headers?: Record<string, string>;
  /** 覆盖默认的 Prefer（delta 分页时不需要再带时区） */
  prefer?: string;
}

/**
 * 发一个 Graph 请求。
 *
 * 返回 `etag` 而不是让调用方自己读 header：回写时 If-Match 全靠它，
 * 漏读一次就会变成"盲写"，把别人刚改的会议覆盖掉。
 */
export async function graphFetch<T>(
  accessToken: string,
  pathOrUrl: string,
  init: RequestInitLite = {},
): Promise<GraphResponse<T>> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
    prefer: init.prefer ?? `outlook.timezone="${CAL_TIME_ZONE}"`,
    ...init.headers,
  };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.ifMatch) headers['if-match'] = init.ifMatch;

  let lastError: GraphError | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await acquire();
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      release();
      lastError = new GraphError(
        `连接 Graph 失败：${err instanceof Error ? err.message : String(err)}`,
        0,
        'network_error',
      );
      if (attempt < MAX_RETRIES) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw lastError;
    }
    release();

    if (res.status === 204 || res.status === 202) {
      return { json: {} as T, etag: res.headers.get('etag'), status: res.status };
    }

    const text = await res.text();
    let json: unknown = null;
    if (text !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    if (res.ok) {
      return { json: (json ?? {}) as T, etag: res.headers.get('etag'), status: res.status };
    }

    const body = (json ?? {}) as { error?: { code?: string; message?: string } };
    const code = body.error?.code ?? `http_${res.status}`;
    const retryAfter = Number(res.headers.get('retry-after') ?? 0);

    lastError = new GraphError(
      body.error?.message ?? `Graph 返回 HTTP ${res.status}`,
      res.status,
      code,
      retryAfter > 0 ? retryAfter : undefined,
    );

    // 429 与 5xx 才值得重试；4xx 的其余状态重试只会让限流更严重
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) throw lastError;

    const backoff = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
    await sleep(Math.min(backoff, 20_000));
  }

  throw lastError ?? new GraphError('Graph 请求失败', 0, 'unknown');
}

// ── 日历列表 ────────────────────────────────────────────────

export interface GraphCalendar {
  id: string;
  name: string;
  canEdit: boolean;
  isDefaultCalendar: boolean;
  hexColor: string | null;
}

export async function listCalendars(accessToken: string): Promise<GraphCalendar[]> {
  const out: GraphCalendar[] = [];
  let url: string | null = '/me/calendars?$top=50&$select=id,name,canEdit,isDefaultCalendar,hexColor';
  let guard = 0;
  while (url && guard < 10) {
    const page: GraphResponse<{ value?: unknown[]; '@odata.nextLink'?: string }> = await graphFetch(
      accessToken,
      url,
    );
    for (const raw of page.json.value ?? []) {
      const item = raw as Record<string, unknown>;
      if (typeof item.id !== 'string' || item.id === '') continue;
      out.push({
        id: item.id,
        name: typeof item.name === 'string' && item.name !== '' ? item.name : '未命名日历',
        // canEdit 缺失时按"可写"处理过乐观，会让人白拖一次；这里反过来按不可写，
        // 大不了需要重新点一次同步，而不是把只读日历当成可编辑
        canEdit: item.canEdit === true,
        isDefaultCalendar: item.isDefaultCalendar === true,
        hexColor: typeof item.hexColor === 'string' ? item.hexColor : null,
      });
    }
    url = typeof page.json['@odata.nextLink'] === 'string' ? page.json['@odata.nextLink'] : null;
    guard += 1;
  }
  return out;
}

// ── 事件 ────────────────────────────────────────────────────

export interface GraphDateTime {
  dateTime: string;
  timeZone: string;
}

export interface GraphEvent {
  id: string;
  iCalUId?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  location?: { displayName?: string | null } | null;
  start?: GraphDateTime;
  end?: GraphDateTime;
  isAllDay?: boolean;
  isOrganizer?: boolean;
  responseStatus?: { response?: string | null } | null;
  type?: string | null;
  seriesMasterId?: string | null;
  /** 被取消的会议仍然留在日历上，但内容已作废——要按删除处理 */
  isCancelled?: boolean;
  recurrence?: Record<string, unknown> | null;
  webLink?: string | null;
  '@odata.etag'?: string;
  '@removed'?: { reason?: string };
  lastModifiedDateTime?: string;
}

const EVENT_SELECT = [
  'id',
  'iCalUId',
  'subject',
  'bodyPreview',
  'location',
  'start',
  'end',
  'isAllDay',
  'isOrganizer',
  'responseStatus',
  'type',
  'seriesMasterId',
  'isCancelled',
  'recurrence',
  'webLink',
  'lastModifiedDateTime',
].join(',');

export interface DeltaPage {
  events: GraphEvent[];
  nextLink: string | null;
  deltaLink: string | null;
}

/**
 * 拉一页 `/me/calendars/{id}/events/delta`。
 *
 * 为什么不按文档 §6.4 用 `calendarView/delta` 当主通道：
 * calendarView 会把重复事件**展开成一个个实例**返回，每个实例有自己的 id，
 * 而且窗口滑动时实例会不断"新增/消失"。照它写库就等于把"规则 + 例外"
 * 退化成一堆快照行，本地再也无法用 RRULE 展开，翻到一个月后就没有事件了。
 * `events/delta` 返回的是母体（带 recurrence），正好对上我们的展开模型。
 */
export async function deltaEventsPage(accessToken: string, url: string): Promise<DeltaPage> {
  const page = await graphFetch<{
    value?: GraphEvent[];
    '@odata.nextLink'?: string;
    '@odata.deltaLink'?: string;
  }>(accessToken, url, {
    prefer: `outlook.timezone="${CAL_TIME_ZONE}", odata.maxpagesize=100`,
  });

  return {
    events: page.json.value ?? [],
    nextLink: typeof page.json['@odata.nextLink'] === 'string' ? page.json['@odata.nextLink'] : null,
    deltaLink: typeof page.json['@odata.deltaLink'] === 'string' ? page.json['@odata.deltaLink'] : null,
  };
}

/**
 * 初始 delta 地址（**按日历**拉）。
 *
 * 为什么不做 `/me/events/delta` 一把抓：事件对象里没有 calendarId，
 * 也没有 parentFolderId（实测 $select 会报 "Could not find a property named 'parentFolderId'"），
 * 一把抓回来就无法知道它属于哪个日历，于是"生日/节假日默认不同步"
 * 和"只读日历不能拖"这两条都实现不了。按日历拉则天然带上了归属。
 *
 * 另外 delta 端点**不接受 $top**（会在分页边界丢事件），页大小只能用
 * `Prefer: odata.maxpagesize`。
 */
export function deltaStartUrl(calendarId: string): string {
  return `/me/calendars/${encodeURIComponent(calendarId)}/events/delta?$select=${encodeURIComponent(EVENT_SELECT)}`;
}

export interface EventPatchBody {
  subject?: string;
  start?: { dateTime: string; timeZone: string };
  end?: { dateTime: string; timeZone: string };
  location?: { displayName: string };
  isAllDay?: boolean;
}

/** PATCH 一条事件。带 If-Match，远端已改时返回 412 而不是静默覆盖 */
export async function patchEvent(
  accessToken: string,
  eventId: string,
  body: EventPatchBody,
  etag: string | null,
): Promise<void> {
  await graphFetch(accessToken, `/me/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body,
    ...(etag ? { ifMatch: etag } : {}),
  });
}

export async function deleteEvent(accessToken: string, eventId: string, etag: string | null): Promise<void> {
  await graphFetch(accessToken, `/me/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    ...(etag ? { ifMatch: etag } : {}),
  });
}

export async function getEvent(accessToken: string, eventId: string): Promise<GraphEvent> {
  const res = await graphFetch<GraphEvent>(accessToken, `/me/events/${encodeURIComponent(eventId)}`);
  return res.json;
}

/** 创建一个测试/新日历（仅验收脚本与将来的"GRID 日历"用） */
export async function createCalendar(accessToken: string, name: string): Promise<string> {
  const res = await graphFetch<{ id?: string }>(accessToken, '/me/calendars', {
    method: 'POST',
    body: { name },
  });
  if (typeof res.json.id !== 'string') throw new GraphError('创建日历失败：响应没有 id', 0, 'bad_response');
  return res.json.id;
}

export async function deleteCalendar(accessToken: string, calendarId: string): Promise<void> {
  await graphFetch(accessToken, `/me/calendars/${encodeURIComponent(calendarId)}`, { method: 'DELETE' });
}

export async function createEvent(
  accessToken: string,
  calendarId: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await graphFetch<{ id?: string }>(
    accessToken,
    `/me/calendars/${encodeURIComponent(calendarId)}/events`,
    { method: 'POST', body },
  );
  if (typeof res.json.id !== 'string') throw new GraphError('创建事件失败：响应没有 id', 0, 'bad_response');
  return res.json.id;
}
