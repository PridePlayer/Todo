/**
 * CSV 解析与生成（RFC 4180 的最小实现）。
 *
 * 为什么手写而不引 papaparse：这里只处理"用户从 Excel 另存、或按模板手填"的文件，
 * 规则就那么几条；而多一个依赖要跟着 Expo/Vite 的版本走，不划算。
 *
 * 三个必须处理对的点，每一个都是"看起来能跑、实际会错"：
 *   1. 引号内的逗号与换行不能当分隔符（备注里写了一句"第一，第二"就会串行）
 *   2. 双引号转义是 `""` 而不是 `\"`
 *   3. 行尾可能是 \r\n / \n / \r —— Excel 在 Windows 上给的是 \r\n
 */

/** 去掉 UTF-8 BOM。Excel 另存的 CSV 一定有，不去掉的话第一个表头会变成 `\uFEFF标题`，匹配不上 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseCsv(text: string): string[][] {
  const source = stripBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;

    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          // "" → 一个字面双引号
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      // \r\n 吃掉两个字符
      i += ch === '\r' && source[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // 最后一行没有换行符收尾时补上
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // 丢掉纯空行（全空字段的尾行 Excel 经常留一条）
  return rows.filter((line) => line.some((cell) => cell.trim() !== ''));
}

function escapeCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  // 含逗号、引号、换行就必须加引号，否则解析回来会错位
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * 生成 CSV 文本。
 *
 * 默认带 BOM：不带的话，Excel 双击打开会把 UTF-8 当 GBK，中文模板变成乱码 ——
 * 而用户看到乱码的第一反应是"这个下载坏了"，不会想到是编码问题。
 */
export function toCsv(rows: (string | number | null | undefined)[][], options: { bom?: boolean } = {}): string {
  const body = rows.map((row) => row.map(escapeCell).join(',')).join('\r\n');
  return options.bom === false ? body : `\ufeff${body}`;
}

/**
 * 读文件并解码。
 *
 * 两条现实路径：
 *   · 模板下载 → 在 Excel 里填 → 另存为 CSV（中文 Windows 上默认 **GBK**）
 *   · 用 VSCode / Numbers / Google Sheets 导出（**UTF-8**）
 *
 * 先按 UTF-8 严格解码（`fatal: true` 遇到非法字节直接抛），失败再退回 GBK。
 * 反过来做不行：GBK 解码几乎不会失败，会把 UTF-8 的中文解成乱码却不报错。
 */
export async function readCsvFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  try {
    return stripBom(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch {
    try {
      return stripBom(new TextDecoder('gbk').decode(buffer));
    } catch {
      // 两种都不行就按 UTF-8 宽松解码，让用户至少看到部分内容并自己发现乱码
      return stripBom(new TextDecoder('utf-8').decode(buffer));
    }
  }
}
