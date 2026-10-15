import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

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
  plugins: [react(), tailwindcss()],
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
