import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * 普通浏览器入口（新 Renderer 的唯一网页构建）。
 *
 * 与 Electron 完全解耦：不加载 Main、preload、helper 或 Python，
 * 也不依赖桌面桥接对象。产物只写 `.build/web`，不触碰旧 `dist/`。
 * 演示素材以 `publicDir = .build/mock-assets` 提供 `/__mock/...`，
 * 开发与构建都走同一套同源静态资源路径。
 */
export default defineConfig({
  root: path.resolve(import.meta.dirname, 'src/renderer'),
  base: '/',
  publicDir: path.resolve(import.meta.dirname, '.build/mock-assets'),
  plugins: [react(), tailwindcss(), devSessionPlugin()],
  define: {
    // "关于"页展示真实版本；构建期注入，不运行时读取，也不联网。
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  resolve: {
    alias: {
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
      '@': path.resolve(import.meta.dirname, 'src/renderer'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    proxy: {
      /**
       * 浏览器直连真实后端的唯一联通路径。
       *
       * 浏览器只访问同源的 `/api`，由开发服务器转发到本机后端，
       * 因此不需要放宽后端的 CORS/Host 允许列表，也不需要把会话令牌
       * 交给页面：令牌只在开发服务器进程内读取并注入请求头。
       *
       * 令牌来源是启动开发服务器的进程环境变量 `KUMIPLAYER_API_TOKEN`
       * （与桌面壳注入后端的是同一个名称）。未设置时不注入，
       * 对应后端"未设置令牌即开发免会话"的既有兼容行为。
       * 不读取 `VITE_*`，令牌不会进入构建产物、URL 或页面存储。
       */
      '/api': {
        target: process.env.KUMIPLAYER_API_BASE ?? 'http://127.0.0.1:37821',
        changeOrigin: true,
        /**
         * 上游 uvicorn 会在空闲后关闭连接；复用池化 keep-alive socket 会得到 ECONNRESET。
         * 开发代理是单用户本机链路，用每次新建连接换取确定性，不做连接池复用。
         */
        agent: false,
        proxyTimeout: 60_000,
        timeout: 60_000,
        configure: (proxy) => {
          const token = (process.env.KUMIPLAYER_API_TOKEN ?? '').trim();
          if (token.length === 0) {
            return;
          }
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('X-KumiPlayer-Token', token);
          });
        },
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 5274,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(import.meta.dirname, '.build/web'),
    emptyOutDir: true,
    sourcemap: false,
  },
  clearScreen: false,
});

/**
 * 仅开发服务器使用的会话注入插件（`apply: 'serve'`，构建产物不含任何令牌）。
 *
 * 开发直连本机后端需要两件事：后端地址（非秘密）与短期会话令牌。
 * 令牌只在开发服务器进程内从环境变量 `KUMIPLAYER_API_TOKEN` 读取，
 * 注入到页面内存，不写入 `VITE_*`、构建产物、URL、localStorage 或日志。
 * 后端需要用 `KUMIPLAYER_DEV_ORIGINS` 显式允许本开发来源（默认关闭），
 * 因此这不是放宽任意 CORS。
 */
function devSessionPlugin() {
  return {
    name: 'kumiplayer-dev-session',
    apply: 'serve' as const,
    transformIndexHtml(html: string) {
      const token = (process.env.KUMIPLAYER_API_TOKEN ?? '').trim();
      if (token.length === 0) {
        return html;
      }
      // 一键入口走同源代理，避免复用后端时依赖额外的跨域放行。
      const apiBase = process.env.KUMIPLAYER_WEB_SAME_ORIGIN === '1'
        ? '' : process.env.KUMIPLAYER_API_BASE ?? 'http://127.0.0.1:37821';
      const payload = JSON.stringify({ apiBase, apiToken: token });
      return html.replace(
        '</head>',
        `    <script>window.__KUMIPLAYER_APP_CONFIG__ = ${payload};</script>\n  </head>`,
      );
    },
  };
}
