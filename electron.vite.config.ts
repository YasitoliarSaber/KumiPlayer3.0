import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const sharedDir = path.resolve(import.meta.dirname, 'src/shared');
const outDir = path.resolve(import.meta.dirname, '.build/desktop');

/**
 * 新桌面候选的独立构建配置：三目标分离，输出只进 .build/desktop，
 * 不覆盖当前 Tauri 使用的 dist/，也不改动旧 vite.config.ts。
 *
 * main/preload 显式产出 CJS：沙箱 preload 不能是 ESM，
 * 而根 package.json 的 `type: module` 会把 .js 当作 ESM。
 */
export default defineConfig({
  main: {
    resolve: { alias: { '@shared': sharedDir } },
    build: {
      outDir: path.join(outDir, 'main'),
      emptyOutDir: true,
      minify: false,
      lib: {
        entry: path.resolve(import.meta.dirname, 'src/main/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.cjs',
      },
      rollupOptions: {
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  preload: {
    resolve: { alias: { '@shared': sharedDir } },
    build: {
      outDir: path.join(outDir, 'preload'),
      emptyOutDir: true,
      minify: false,
      lib: {
        entry: path.resolve(import.meta.dirname, 'src/preload/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.cjs',
      },
      rollupOptions: {
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: path.resolve(import.meta.dirname, 'src/renderer'),
    base: '/',
    plugins: [react()],
    resolve: { alias: { '@shared': sharedDir } },
    build: {
      outDir: path.join(outDir, 'renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: path.resolve(import.meta.dirname, 'src/renderer/index.html'),
      },
    },
  },
});
