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
    const forbidden = [/@fluentui\//, /\.\.\/index\.css$/, /src\/index\.css$/];
    expect(violations('src/renderer', forbidden)).toEqual([]);
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
