/**
 * 模块边界门禁（B 4.2 / T2-1）。
 *
 * TypeScript 只能证明类型层，不能证明 import 边界；这里直接扫描源码，
 * 保证 Renderer 不引入 Node/Electron，Main 不引用 React，
 * 纯契约不依赖任何运行时宿主。
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(__dirname, '..', '..');

function listSourceFiles(dir: string): string[] {
  const root = path.join(projectRoot, dir);
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

/** 样式文件也要扫描：旧组件库过去正是以 CSS `@import` 形式回流。 */
function listStyleFiles(dir: string): string[] {
  const root = path.join(projectRoot, dir);
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.css$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

function importsOf(file: string): readonly string[] {
  const source = fs.readFileSync(file, 'utf8');
  const matches = source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g);
  return [...matches].map((match) => match[1] ?? '');
}

function violations(dir: string, forbidden: readonly RegExp[]): readonly string[] {
  const found: string[] = [];
  for (const file of listSourceFiles(dir)) {
    for (const specifier of importsOf(file)) {
      if (forbidden.some((pattern) => pattern.test(specifier))) {
        found.push(`${path.relative(projectRoot, file)} -> ${specifier}`);
      }
    }
  }
  return found;
}

const NODE_OR_ELECTRON = [/^node:/, /^electron$/, /^node_modules/];
const REACT_OR_DOM = [/^react$/, /^react-dom/, /^@mantine\//, /^@tanstack\/react-/];

describe('新旧前端模块边界', () => {
  it('Renderer 不引入 Node、Electron 或任何 Node 内置模块', () => {
    expect(violations('src/renderer', NODE_OR_ELECTRON)).toEqual([]);
  });

  it('Renderer 不直接依赖旧 Fluent UI 与旧全局样式', () => {
    // Mantine 已从新前端移除：把它一并锁进禁令，防止后续回退。
    const forbidden = [/@fluentui\//, /@mantine\//, /\.\.\/index\.css$/, /src\/index\.css$/];
    expect(violations('src/renderer', forbidden)).toEqual([]);
  });

  it('样式文件不导入旧组件库或旧全局样式', () => {
    const styleHits: string[] = [];
    for (const file of listStyleFiles('src/renderer')) {
      const css = fs.readFileSync(file, 'utf8');
      for (const match of css.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)) {
        const target = match[1] ?? '';
        if (/@mantine|@fluentui/.test(target) || /index\.css$/.test(target)) {
          styleHits.push(`${path.relative(projectRoot, file)} -> ${target}`);
        }
      }
    }
    expect(styleHits).toEqual([]);
  });

  it('新 Renderer 只用一套 UI 原语（shadcn/ui + radix-ui）', () => {
    const files = listSourceFiles('src/renderer');
    const uiImports = new Set<string>();
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        if (
          specifier.startsWith('@/shared/ui/') ||
          specifier === 'radix-ui' ||
          specifier.startsWith('@tanstack/react-') ||
          // 精确到包名：`react-*` 前缀不能放行 react-bootstrap 等第二套组件库。
          specifier === 'react' ||
          specifier === 'react-dom' ||
          specifier === 'react-dom/client' ||
          specifier === 'react-router' ||
          specifier === 'react-router-dom' ||
          specifier === 'zustand' ||
          specifier === 'lucide-react' ||
          specifier.startsWith('@shared/') ||
          specifier.startsWith('@/')
        ) {
          if (specifier === 'radix-ui') {
            uiImports.add('radix-ui');
          }
          continue;
        }
        // 其余第三方依赖必须显式出现在允许名单里，避免悄悄混入第二套组件库。
        const packageName = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0]!;
        if (packageName.startsWith('.') === false && !packageName.startsWith('node:')) {
          uiImports.add(packageName);
        }
      }
    }
    const allowed = new Set(['clsx', 'tailwind-merge', 'class-variance-authority', 'radix-ui']);
    const unexpected = [...uiImports].filter((name) => !allowed.has(name));
    expect(unexpected).toEqual([]);
  });

  it('跨进程纯契约不依赖 React、Electron 或 Node', () => {
    expect(violations('src/shared', [...NODE_OR_ELECTRON, ...REACT_OR_DOM])).toEqual([]);
  });

  it('Main 与 Preload 不引用 React 渲染层', () => {
    expect(violations('src/main', REACT_OR_DOM)).toEqual([]);
    expect(violations('src/preload', REACT_OR_DOM)).toEqual([]);
  });

  it('Preload 不暴露通用 invoke(channel) 或文件系统能力', () => {
    const preload = fs.readFileSync(
      path.join(projectRoot, 'src', 'preload', 'index.ts'),
      'utf8',
    );
    expect(preload).not.toMatch(/exposeInMainWorld\(['"]kumiplayer['"],\s*\{[^}]*ipcRenderer/);
    expect(preload).not.toMatch(/\brequire\(['"]node:fs['"]\)/);
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*invoke\s*:\s*ipcRenderer\.invoke/);
  });
});
