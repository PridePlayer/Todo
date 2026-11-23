/**
 * 登出时必须把客户端残留全部清掉，否则下一个用这台机器的人能看到上一个人的数据。
 * 对应 docs/02-架构与技术方案.md §5.4 的清单。
 *
 * M0 还没有 Dexie，但这段代码从第一天起就去枚举并删除所有 IndexedDB，
 * 这样 M1 加上本地库时不需要回来改登出逻辑（少了这个"回来改"，就少了一个泄露点）。
 */
export async function clearClientState(): Promise<void> {
  try {
    localStorage.clear();
  } catch {
    /* 隐私模式下可能抛错，忽略 */
  }
  try {
    sessionStorage.clear();
  } catch {
    /* 同上 */
  }
  await deleteAllIndexedDb();
}

async function deleteAllIndexedDb(): Promise<void> {
  const idb = globalThis.indexedDB as IDBFactory & { databases?: () => Promise<IDBDatabaseInfo[]> };
  if (!idb || typeof idb.databases !== 'function') return;

  try {
    const databases = await idb.databases();
    await Promise.all(
      databases.map(
        (info) =>
          new Promise<void>((resolve) => {
            if (!info.name) return resolve();
            const req = idb.deleteDatabase(info.name);
            // blocked 也要 resolve：说明还有别的标签页占着库，不能因此卡死登出流程
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          }),
      ),
    );
  } catch {
    /* 某些浏览器在无痕模式禁用 databases()，忽略 */
  }
}
