#!/usr/bin/env node
/**
 * 提交前自查：.env 里的真实值有没有漏进被追踪的文件。
 *
 * 起因：docs 和几个调试脚本里长期硬编码着本地库的邮箱与口令，
 * 而这个仓库是公开的。`.env` 本身没被提交（.gitignore 挡着），
 * 但只要有人手滑 `git add -f .env`，或者把口令复制进一份文档、
 * 一个调试脚本，就再也删不干净了——git 历史是追加的。
 *
 * 用法：
 *   node tools/check-secrets.mjs        # 发现即退出码 1，可挂进 CI / pre-commit
 *
 * 它只做一件事，但做得比较准：拿 .env 里每个「看起来像秘密」的值，
 * 逐字符去比对仓库里被 git 追踪的文件。不猜正则，不扫熵值——那种做法
 * 会淹没在误报里，最后没人看。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const ENV_FILE = '.env';

/** 这些是配置而不是秘密：短、公开、或者本来就是给人看的默认值 */
const HARMLESS = [
  /^(true|false|1|0)$/,
  /^(production|development|test|info|debug|warn|error|trace|fatal)$/,
  /^(common|consumers|organizations)$/,
  /^https?:\/\/(localhost|127\.0\.0\.1)/,
  /^sqlite:/,
  /^[\d.:]+$/, // 端口、监听地址
];

/**
 * 键名白名单：这些值公开且无害，出现在代码里是正常的。
 * 典型的是 MS_SCOPES —— `offline_access User.Read Calendars.ReadWrite`
 * 既是 .env 的默认值，也必然出现在 env.ts 的 schema 默认值里。
 * 放不进白名单会让这个检查永远红着，然后就没人看了。
 */
const EXEMPT_KEYS = new Set(['MS_SCOPES', 'MS_TENANT', 'MS_REDIRECT_URI', 'APP_ORIGIN', 'LOG_LEVEL']);

/** 这几类文件本来就该出现占位符和默认值 */
const SKIP_FILES = new Set(['.env', '.env.example', 'deploy/env.example']);

/** 令牌/私钥的形态：跟 .env 有没有配无关，出现就说明有问题 */
const SUSPICIOUS_PATTERNS = [
  { name: 'SSH/PGP 私钥', re: /BEGIN (?:RSA|OPENSSH|EC|PGP|DSA) PRIVATE KEY/ },
  { name: '阿里云 AccessKey', re: /\bLTAI[A-Za-z0-9]{12,}/ },
  { name: 'AWS AccessKey', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'OpenAI/DeepSeek 风格 key', re: /\bsk-[A-Za-z0-9]{24,}/ },
];

function isHarmless(value) {
  return HARMLESS.some((re) => re.test(value));
}

function parseEnv(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    // 跳过注释与空行；值里允许有空格（MS_SCOPES 就是），所以不按 = 之后的空格切
    const line = raw.replace(/\r$/, '');
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out.push({ key, value });
  }
  return out;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function main() {
  if (!existsSync(ENV_FILE)) {
    console.log(`[secrets] 没有 ${ENV_FILE}，跳过（这个检查是用来比对真实值的）`);
    process.exit(0);
  }

  const entries = parseEnv(readFileSync(ENV_FILE, 'utf8'));
  const files = trackedFiles().filter((f) => !SKIP_FILES.has(f));

  // 一次性把文件读进内存：237 个文件、几百 KB，比逐次读盘快得多，
  // 而且能顺便统计"这个值出现在哪几个文件里"。
  const bodies = new Map();
  for (const f of files) {
    try {
      bodies.set(f, readFileSync(f, 'utf8'));
    } catch {
      // 二进制文件 / 权限问题，跳过
    }
  }

  const problems = [];

  for (const { key, value } of entries) {
    if (value.length < 8 || isHarmless(value) || EXEMPT_KEYS.has(key)) continue;
    for (const [file, body] of bodies) {
      if (body.includes(value)) problems.push({ kind: '.env 真实值', key, file });
    }
  }

  for (const [file, body] of bodies) {
    for (const { name, re } of SUSPICIOUS_PATTERNS) {
      if (re.test(body)) problems.push({ kind: name, key: '—', file });
    }
  }

  if (problems.length === 0) {
    console.log(`[secrets] ✓ 检查了 ${bodies.size} 个被追踪的文件，没有发现 .env 的真实值或密钥形态`);
    process.exit(0);
  }

  console.error('[secrets] ✗ 发现疑似泄漏：\n');
  for (const p of problems) {
    console.error(`  ${p.file}  ←  ${p.kind}${p.key !== '—' ? ` (${p.key})` : ''}`);
  }
  console.error(
    '\n处理：把值换成占位符，需要真实值的地方改成从环境变量读。' +
      '\n注意 git 历史里已经存在的部分删不掉——最有效的补救是把这个口令本身换掉。',
  );
  process.exit(1);
}

main();
