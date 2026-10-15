#!/usr/bin/env node
/**
 * 桌面演示模式的统一启动器。
 *
 * 用法：
 *   node scripts/desktop/run-desktop.cjs dev      开发模式（Vite dev server + Electron）
 *   node scripts/desktop/run-desktop.cjs run      运行已构建的 JS/HTML 产物
 *   node scripts/desktop/run-desktop.cjs verify   运行已构建产物并逐页截图验证
 *
 * 三个子命令都固定注入 `KUMIPLAYER_DESKTOP_MOCK=1`：
 * 演示模式必须显式选择，桌面主进程不会创建 BackendManager，
 * 不会启动 Python/helper，也不访问 37821 或任何真实图片服务。
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const command = process.argv[2] ?? 'dev';

const electronViteBin = path.join(projectRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
const electronBin = path.join(
  projectRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);
const mainEntry = path.join(projectRoot, '.build', 'desktop', 'main', 'index.cjs');

const mockEnv = {
  ...process.env,
  KUMIPLAYER_DESKTOP_MOCK: '1',
  ...(command === 'verify' ? { KUMIPLAYER_DESKTOP_VERIFY: '1' } : {}),
};

function runPrepare() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'prepare-mock-assets.cjs')], {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('演示素材准备失败'))));
  });
}

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: projectRoot,
      env: mockEnv,
      stdio: 'inherit',
    });
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(script)} 退出码 ${code}`))));
    child.once('error', reject);
  });
}

function runElectron(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronBin, args, {
      cwd: projectRoot,
      env: mockEnv,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.once('exit', (code) => resolve(code ?? 1));
    child.once('error', reject);
  });
}

async function main() {
  await runPrepare();

  if (command === 'dev') {
    await runNode(electronViteBin, ['dev']);
    return;
  }

  if (!fs.existsSync(mainEntry)) {
    console.error('未找到构建产物，请先运行 npm run build:desktop:js');
    process.exit(1);
  }

  const code = await runElectron([mainEntry]);
  if (command === 'verify' && code !== 0) {
    console.error(`演示模式验证未通过（退出码 ${code}），详见 .build/desktop/verify/mock/`);
    process.exit(code);
  }
  process.exit(command === 'verify' ? code : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
