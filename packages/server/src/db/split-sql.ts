/**
 * 把一份 SQL 文件切成单条语句。
 *
 * 不用 `sql.split(';')` —— 注释里的分号、字符串里的分号都会把它切坏，
 * 而这种 bug 表现为"迁移跑到一半失败"，排查成本远高于这 40 行。
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let buf = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i]!;

    // 行注释 --
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }

    // 块注释 /* */
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    // 单引号字符串（'' 转义）
    if (ch === "'") {
      buf += ch;
      i += 1;
      while (i < n) {
        const c = sql[i]!;
        buf += c;
        i += 1;
        if (c === "'") {
          if (sql[i] === "'") {
            buf += "'";
            i += 1;
          } else break;
        }
      }
      continue;
    }

    // 反引号标识符
    if (ch === '`') {
      buf += ch;
      i += 1;
      while (i < n) {
        const c = sql[i]!;
        buf += c;
        i += 1;
        if (c === '`') break;
      }
      continue;
    }

    if (ch === ';') {
      const trimmed = buf.trim();
      if (trimmed) statements.push(trimmed);
      buf = '';
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }

  const tail = buf.trim();
  if (tail) statements.push(tail);
  return statements;
}
