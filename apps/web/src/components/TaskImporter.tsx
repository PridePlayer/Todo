import { useCallback, useRef, useState } from 'react';
import { importTasks, type ImportOutcome } from '../db/import';
import { parseCsv, readCsvFile, toCsv } from '../lib/csv';
import { parseRows, templateRows, type ParseOutcome } from '../lib/task-import';
import styles from './TaskImporter.module.css';

/**
 * 批量导入任务（docs/12）。
 *
 * 交互刻意做成"先看再导"而不是"选完文件直接导"：
 * CSV 是人手填的，一定有零星格式错误，而"整批失败"意味着任何一处错误都会让整批白做。
 * 让用户在点导入之前就看见"第几行错在哪"，比导完再报错重来省一轮。
 */

const MAX_SHOWN_ERRORS = 10;

/**
 * 单次导入上限。
 *
 * 不是拍脑袋：导入是"一个 Dexie 事务 + 一次 bulkAdd"，2000 条在普通笔记本上约 1–2 秒，
 * 界面会明显卡一下但能接受。上万条时事务持有时间过长，浏览器可能直接判定页面假死、弹"终止脚本"。
 * 分批导两次比让用户遇到一次假死好。
 */
const MAX_IMPORT_ROWS = 2000;

function downloadTemplate(): void {
  const csv = toCsv(templateRows());
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'GRID-任务导入模板.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 立刻回收：不 revoke 的话这个 Blob 会一直占着内存直到刷新页面
  URL.revokeObjectURL(url);
}

export function TaskImporter() {
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ParseOutcome | null>(null);
  const [result, setResult] = useState<ImportOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setBusy(true);
    setError(null);
    setResult(null);
    setOutcome(null);
    try {
      const text = await readCsvFile(file);
      const table = parseCsv(text);
      setOutcome(parseRows(table));
      setFileName(file.name);
    } catch (err) {
      setError(`读取失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const handleImport = useCallback(async () => {
    if (!outcome) return;
    // 双保险：按钮在出错时已经是 disabled，这里再挡一次，
    // 免得将来有人把按钮挪到别处时忘了带 disabled 条件
    if (outcome.fatal !== null || outcome.errors.length > 0 || outcome.rows.length === 0) return;

    setBusy(true);
    setError(null);
    try {
      const res = await importTasks(outcome.rows);
      setResult(res);
      setOutcome(null);
      setFileName(null);
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      setError(`导入失败，没有写入任何数据：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [outcome]);

  const blocked = outcome !== null && (outcome.fatal !== null || outcome.errors.length > 0);
  const tooMany = outcome !== null && outcome.rows.length > MAX_IMPORT_ROWS;

  return (
    <div className={styles.wrap}>
      <p className={styles.lead}>
        按模板填好 CSV 后上传，一次可以导入任意条数。导入的是<strong>未完成任务</strong>，
        全部落在收件箱，然后走正常同步推到服务端。
      </p>

      <div className={styles.actions}>
        <button type="button" className={styles.ghost} onClick={downloadTemplate}>
          下载模板（CSV）
        </button>

        <label className={styles.fileLabel}>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            className={styles.fileInput}
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          选择 CSV 文件
        </label>

        {fileName ? <span className={styles.fileName}>{fileName}</span> : null}
      </div>

      <details className={styles.help}>
        <summary>模板各列怎么填</summary>
        <ul className={styles.helpList}>
          <li>
            <code>标题</code> 必填，最长 512 字。
          </li>
          <li>
            <code>日期</code> 写 <code>2026-12-01</code>；留空表示不排期。
          </li>
          <li>
            <code>时间</code> 写 <code>09:30</code>；留空就是全天任务。填了时间必须有日期。
          </li>
          <li>
            <code>结束时间</code> 可留空，填了必须晚于开始时间（跨天请拆成两条）。
          </li>
          <li>
            <code>象限</code> 填 <code>01</code>–<code>04</code> 或 1–4，留空按 04 处理。
          </li>
          <li>
            <code>优先级</code> 填 无/低/中/高 或 0–3。
          </li>
          <li>
            <code>标签</code> 多个用<strong>分号</strong>隔开（<code>工作；紧急</code>），不存在的会自动新建。
          </li>
          <li>
            <code>提醒提前</code> 填分钟数（<code>15</code> 表示提前 15 分钟），留空不提醒。
          </li>
          <li>
            <code>重复</code> 可填 每天 / 工作日 / 每周一…每周日 / 每月 / 每月15号 / 每年。
            「每月」「每年」取<strong>日期列</strong>的锚点，不能单独指定几号。
          </li>
        </ul>
        <p className={styles.helpNote}>
          标题和日期完全相同的行会被跳过——同一份文件导两次不会变成两份。保存在 Excel 里时选
          「CSV UTF-8」，用默认的「CSV（逗号分隔）」也能读，只是用 GBK 编码，我会自动识别。
        </p>
      </details>

      {error ? <p className={styles.error}>{error}</p> : null}

      {outcome ? (
        <div className={styles.preview}>
          {outcome.fatal ? (
            <p className={styles.error}>{outcome.fatal}</p>
          ) : (
            <>
              <p className={styles.summary}>
                共 <strong>{outcome.total}</strong> 行 · 可导入 <strong>{outcome.rows.length}</strong> 条
                {outcome.errors.length > 0 ? (
                  <>
                    {' '}
                    · <span className={styles.bad}>有 {outcome.errors.length} 行有问题</span>
                  </>
                ) : null}
              </p>

              {outcome.errors.length > 0 ? (
                <div className={styles.errorBox}>
                  <p className={styles.errorTitle}>下面这些行需要先改好，否则一条都不会导入：</p>
                  <ul className={styles.errorList}>
                    {outcome.errors.slice(0, MAX_SHOWN_ERRORS).map((item) => (
                      <li key={item.line}>
                        <span className={styles.lineNo}>第 {item.line} 行</span>
                        {item.message}
                      </li>
                    ))}
                  </ul>
                  {outcome.errors.length > MAX_SHOWN_ERRORS ? (
                    <p className={styles.more}>还有 {outcome.errors.length - MAX_SHOWN_ERRORS} 行没显示。</p>
                  ) : null}
                </div>
              ) : null}

              {tooMany ? (
                <p className={styles.error}>
                  一次最多导入 {MAX_IMPORT_ROWS} 条，这份文件有 {outcome.rows.length} 条。
                  请拆成几份分别导入——单次太多会让页面卡住。
                </p>
              ) : null}

              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={busy || blocked || tooMany || outcome.rows.length === 0}
                  onClick={() => void handleImport()}
                >
                  {busy ? '导入中…' : `导入 ${outcome.rows.length} 条`}
                </button>
                <button
                  type="button"
                  className={styles.ghost}
                  disabled={busy}
                  onClick={() => {
                    setOutcome(null);
                    setFileName(null);
                    if (inputRef.current) inputRef.current.value = '';
                  }}
                >
                  取消
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {result ? (
        <p className={styles.success}>
          导入完成：新增 <strong>{result.created}</strong> 条
          {result.skipped > 0 ? `，跳过 ${result.skipped} 条（标题和日期已存在）` : ''}
          {result.newTags.length > 0 ? `，新建标签 ${result.newTags.join('、')}` : ''}。
        </p>
      ) : null}
    </div>
  );
}
