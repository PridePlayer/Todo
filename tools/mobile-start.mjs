#!/usr/bin/env node
/**
 * 启动 Metro，自动挑选"手机能连到的那个"IP。
 *
 * 为什么需要它：`expo start --lan` 自己也会选地址，但这台机器上有三张网卡 ——
 *   iKuuuVPN  198.18.0.1     （TUN，手机根本到不了）
 *   vgate0    172.30.x.x     （虚拟组网）
 *   WLAN      10.x / 192.168  （真实局域网，手机能连）
 * Expo 有可能选中第一张，于是二维码里的 IP 手机连不上，表现就是"扫码后一直转圈"，
 * 而且报错信息里没有任何线索指向网卡选错了。
 *
 * 用法：
 *   pnpm mobile:start              局域网（手机与电脑同一 WiFi / 电脑连手机热点）
 *   pnpm mobile:start --tunnel     走 ngrok，手机在任何网络都能连（首次会装 @expo/ngrok）
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileDir = path.resolve(here, '..', 'apps', 'mobile');
const tunnel = process.argv.includes('--tunnel');
// 加了新原生依赖后如果仍然报老错误，是 Metro 缓存没失效，加 --clear 清掉再启
const clear = process.argv.includes('--clear');

/** 私有网段：手机与电脑要互通，必须落在这些段里 */
function isPrivate(ip) {
  if (/^192\.168\./.test(ip)) return 3;
  if (/^10\./.test(ip)) return 2;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1; // 虚拟组网也常在这段，优先级最低
  return 0;
}

/** 明确排除：198.18.0.0/15 是 TUN/基准测试保留段，VPN 客户端常用 */
function isTunnelLike(ip) {
  return /^198\.(18|19)\./.test(ip);
}

const candidates = [];
for (const [name, list] of Object.entries(os.networkInterfaces())) {
  for (const item of list ?? []) {
    if (item.family !== 'IPv4' || item.internal) continue;
    if (isTunnelLike(item.address)) continue;
    candidates.push({ name, address: item.address, rank: isPrivate(item.address) });
  }
}
candidates.sort((a, b) => b.rank - a.rank);

if (!tunnel) {
  console.log('\n本机网卡：');
  for (const c of candidates) {
    console.log(`  ${c.rank > 0 ? '✓' : ' '} ${c.name.padEnd(10)} ${c.address}`);
  }
  if (candidates.length === 0) {
    console.error('\n✗ 找不到任何私有网段地址。手机必然连不上，建议改用 --tunnel。\n');
    process.exit(1);
  }
  console.log(`\n选用 ${candidates[0].address}（${candidates[0].name}）`);
  console.log('如果手机连的不是这个网段，它就连不上 —— 用手机浏览器打开');
  console.log(`  http://${candidates[0].address}:8081/status`);
  console.log('能显示 packager-status:running 才算通。\n');
}

const require = createRequire(path.join(mobileDir, 'package.json'));
const cli = require.resolve('expo/bin/cli');

const env = { ...process.env };
if (!tunnel) env.REACT_NATIVE_PACKAGER_HOSTNAME = candidates[0].address;

const args = [cli, 'start', tunnel ? '--tunnel' : '--lan', '--port', '8081'];
if (clear) args.push('--clear');
const child = spawn(process.execPath, args, { cwd: mobileDir, stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
