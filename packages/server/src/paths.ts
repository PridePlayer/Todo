import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 向上找 pnpm-workspace.yaml 定位仓库根。
 * 好处是 dev（src/）与 build 后（dist/）走同一段代码，不需要写两套相对路径。
 */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i += 1) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export const repoRoot = findRepoRoot(here);

/** packages/server 的绝对路径 —— 迁移文件放在这里，不打进 dist */
export const serverRoot = path.join(repoRoot, 'packages', 'server');

/** 迁移文件目录 */
export const migrationsDir = path.join(serverRoot, 'migrations');

/** 根 .env */
export const envFile = path.join(repoRoot, '.env');
