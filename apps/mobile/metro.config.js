const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

/**
 * pnpm workspace 下的 Metro 配置。
 *
 * 1. watchFolders 加仓库根 —— 否则 `@grid/core` 是 symlink 到
 *    `packages/core`，Metro 的文件监听只覆盖 apps/mobile，改 core 后
 *    热更新不触发，表现为"改了半天没反应"。
 *
 * 2. nodeModulesPaths 同时给项目级和仓库级 —— pnpm 把依赖装在
 *    `node_modules/.pnpm` 下靠 symlink 暴露，Metro 需要知道仓库根也算搜索路径。
 *
 * 3. **不要**设 `resolver.disableHierarchicalLookup = true`。
 *    看着像个"避免捡到全局旧版 react"的好开关，实际上会把 pnpm 的
 *    传递依赖解析彻底打断：`@expo/metro-runtime` 里 `import 'whatwg-fetch'`
 *    时，pnpm 把它放在 `.pnpm/<pkg>@ver/node_modules/` 同级，
 *    只有按文件位置逐级向上查找才找得到。关掉后报
 *    "Unable to resolve module whatwg-fetch"，而且缺一个装一个、永远装不完。
 */
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// @grid/core 是 ESM（package.json type: module）且从 dist 引入，
// 打开 package exports 解析才能按 exports 字段找到 dist/index.js。
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
