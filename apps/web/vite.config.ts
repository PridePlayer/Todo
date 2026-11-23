import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 直指 core 的 TS 源码，改模型不用先 tsc build。服务端走的是 core 的 dist。
      '@grid/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // 前端只认同源 /api，开发时由 Vite 转发到 Fastify；生产由 nginx 转发。
      // 这样代码里不存在任何跨域分支，也就不会出现「本地好、线上 CORS 报错」。
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
  },
  optimizeDeps: {
    // zod 显式列出：否则首次打开会触发一次「发现新依赖 → 重新打包 → 页面刷新」，
    // 表现为登录页莫名闪一下，很容易被当成 bug 排查。
    include: ['zod'],
  },
});
