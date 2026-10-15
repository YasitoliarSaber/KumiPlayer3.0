#!/usr/bin/env node
/**
 * 把 P01 的 Windows 进程宿主从 cargo 产物复制到桌面构建中间目录。
 *
 * 只复制单一可执行文件；不生成旁路 EXE、打包安装包，也不接触 release/。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const built = path.join(
  projectRoot,
  'src',
  'desktop-helper',
  'target',
  'release',
  process.platform === 'win32' ? 'kumiplayer-backend-host.exe' : 'kumiplayer-backend-host',
);
const staging = path.join(projectRoot, '.build', 'desktop', 'helper');

if (!fs.existsSync(built)) {
  console.error(`未找到进程宿主产物：${built}；请先运行 npm run build:helper`);
  process.exit(1);
}
fs.mkdirSync(staging, { recursive: true });
const target = path.join(staging, path.basename(built));
fs.copyFileSync(built, target);
console.log(`已就绪：${path.relative(projectRoot, target)}`);
