/**
 * 设计 token 校验：扫所有 CSS 里引用的 var(--xxx)，逐个对 tokens.css 的定义比对。
 *
 * 为什么需要它：CSS 变量拼错不会报错，`padding: var(--sp-5)` 里 `--sp-5` 不存在时
 * 整条声明被静默丢弃 → padding 退化成 0。症状是"弹层贴边、圆角消失"，
 * 而且是逐处随机出现的，靠人眼看截图一个个发现太贵。
 *
 * 用法：node tools/check-tokens.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const WEB = 'apps/web/src';
const TOKENS_FILE = join(WEB, 'design/tokens.css');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.css')) out.push(path);
  }
  return out;
}

const tokensSource = readFileSync(TOKENS_FILE, 'utf8');

// 定义：出现在声明左侧的 --xxx:（含 @media 里的覆盖）
const defined = new Set();
for (const m of tokensSource.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)) defined.add(m[1]);

// 引用：var(--xxx) 或 var(--xxx, fallback)
const files = walk(WEB);
const problems = [];
const soft = new Set();
let refCount = 0;

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/gi)) {
      const name = m[1];
      const hasFallback = Boolean(m[2]);
      refCount += 1;
      // 有 fallback 的引用（组件通过 inline style 注入的局部变量，如 --cols）
      // 不会是 0，只是没进设计系统，单独记账不判失败
      if (!defined.has(name) && hasFallback) {
        soft.add(name);
      } else if (!defined.has(name)) {
        problems.push({
          file: relative(WEB, file),
          line: i + 1,
          name,
          hasFallback,
          text: line.trim(),
        });
      }
    }
  });
}

if (problems.length === 0) {
  console.log(`✓ ${files.length} 个 CSS 文件、${refCount} 处 var() 引用，全部有定义`);
  if (soft.size > 0) console.log(`  （${[...soft].join('、')} 由组件 inline style 注入，有 fallback）`);
  process.exit(0);
}

console.log(`✗ ${problems.length} 处引用了未定义的 token（共 ${refCount} 处引用）\n`);
for (const p of problems) {
  const tag = p.hasFallback ? '（有 fallback，不会归零）' : '（无 fallback → 整条声明被丢弃）';
  console.log(`  ${p.file}:${p.line}  ${p.name} ${tag}`);
  console.log(`    ${p.text}`);
}
process.exit(1);
