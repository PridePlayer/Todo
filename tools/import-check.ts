/**
 * 批量导入的解析层验收（docs/12 §验收）。
 *
 * 只测纯函数，不碰 IndexedDB —— 落库那一层要用浏览器跑，这里测的是
 * "用户填的 CSV 会不会被正确理解"，也就是最容易出错的那一半。
 *
 * 用法：cd packages/server && ./node_modules/.bin/tsx ../../tools/import-check.ts
 */
import { parseCsv, toCsv } from '../apps/web/src/lib/csv.js';
import { parseRows, templateRows } from '../apps/web/src/lib/task-import.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function parse(text: string) {
  return parseRows(parseCsv(text));
}

// ── 1. 模板自身必须是能用的 ────────────────────────────
const template = toCsv(templateRows());
const t = parse(template);
check('模板能解析且没有错误行', t.fatal === null && t.errors.length === 0, t.fatal ?? `${t.errors.length} 个错误`);
check('模板导出 2 条示例', t.rows.length === 2, `得到 ${t.rows.length}`);
check('模板第一行是全天任务', t.rows[0]?.draft.startAt === null && t.rows[0]?.draft.dueDate === '2026-12-01');
check('模板第二行带时间', t.rows[1]?.draft.startAt !== null);
check(
  '模板第二行的时间落在本地 18:00（不是 UTC 18:00）',
  new Date(t.rows[1]!.draft.startAt!).getHours() === 18,
  `得到 ${new Date(t.rows[1]!.draft.startAt!).getHours()} 点`,
);
check('模板第二行标签用分号拆成两个', t.rows[1]?.tags.length === 2, JSON.stringify(t.rows[1]?.tags));
check('模板第二行重复规则是每周五', t.rows[1]?.draft.rrule === 'FREQ=WEEKLY;BYDAY=FR', String(t.rows[1]?.draft.rrule));

// ── 2. CSV 解析的边界 ────────────────────────────────
const tricky = parseCsv('标题,备注\n"甲,乙","第一行\n第二行"\n"带""引号""",普通');
check('引号内的逗号不串列', tricky[1]?.[0] === '甲,乙', JSON.stringify(tricky[1]));
check('引号内可以换行', tricky[1]?.[1] === '第一行\n第二行');
check('"" 还原成一个双引号', tricky[2]?.[0] === '带"引号"', JSON.stringify(tricky[2]?.[0]));
check('BOM 不会粘在第一个表头前面', parseCsv('\ufeff标题\n值')[0]?.[0] === '标题');

// ── 3. 校验：该报错的必须报错，而且指到行 ──────────────
const bad = parse(
  [
    '标题,日期,时间,结束时间,象限,优先级,标签,地点,备注,提醒提前,重复',
    '正常,2026-12-01,,,,,,, ,,',
    ',2026-12-01,,,,,,,,',                 // 标题空
    '日期错,2026-13-01,,,,,,,,',
    '时间没日期,,09:30,,,,,,,,',
    '结束早于开始,2026-12-01,10:00,09:00,,,,,,,',
    '象限错,2026-12-01,,,09,,,,,,',
    '优先级错,2026-12-01,,,,很高,,,,,',
    '重复没日期,,, ,,, ,,,,每月',
    '提醒过大,2026-12-01,,,,,,, ,20000,',
  ].join('\n'),
);
check('标题为空会报错', bad.errors.some((e) => e.message.includes('标题')));
check('非法日期会报错', bad.errors.some((e) => e.message.includes('2026-13-01')));
check('只有时间没有日期会报错', bad.errors.some((e) => e.message.includes('就必须填「日期」')));
check('结束早于开始会报错', bad.errors.some((e) => e.message.includes('必须晚于')));
check('象限 09 会报错', bad.errors.some((e) => e.message.includes('象限')));
check('优先级「很高」会报错', bad.errors.some((e) => e.message.includes('优先级')));
check('「每月」缺日期会报错', bad.errors.some((e) => e.message.includes('锚点')));
check('提醒 20000 分钟会报错', bad.errors.some((e) => e.message.includes('10080')));
check('行号从 2 开始（表头是第 1 行）', bad.errors.every((e) => e.line >= 2), JSON.stringify(bad.errors.map((e) => e.line)));
check('只有第一行是合法的', bad.rows.length === 1, `得到 ${bad.rows.length}`);

// ── 4. 缺「标题」列属于致命错误 ────────────────────────
const noTitle = parse('日期,时间\n2026-12-01,09:30');
check('缺标题列直接判定致命', noTitle.fatal !== null, String(noTitle.fatal));

// ── 5. 各种重复档位 ──────────────────────────────────
const repeats = parse(
  [
    '标题,日期,重复',
    'a,2026-12-01,每天',
    'b,2026-12-01,工作日',
    'c,2026-12-01,每周三',
    'd,2026-12-01,每月15号',
    'e,2026-12-01,每月',
    'f,2026-12-01,每年',
  ].join('\n'),
);
const rule = (index: number): string => String(repeats.rows[index]?.draft.rrule ?? '');
check('每天', rule(0) === 'FREQ=DAILY', rule(0));
check('工作日', rule(1) === 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', rule(1));
check('每周三', rule(2) === 'FREQ=WEEKLY;BYDAY=WE', rule(2));
check('每月15号', rule(3) === 'FREQ=MONTHLY;BYMONTHDAY=15', rule(3));
check('每月（取日期列的 1 号）', rule(4) === 'FREQ=MONTHLY;BYMONTHDAY=1', rule(4));
check('每年', rule(5) === 'FREQ=YEARLY', rule(5));

// ── 6. 表头别名 ──────────────────────────────────────
const alias = parse('title,due,tags,prio\n从别的工具导来的,2026-12-02,工作;重要,高');
check('英文表头能认', alias.rows.length === 1 && alias.errors.length === 0, JSON.stringify(alias.errors));
check('英文表头的字段映射正确', alias.rows[0]?.draft.dueDate === '2026-12-02' && alias.rows[0]?.draft.priority === 3);

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
