#!/usr/bin/env node
/**
 * P01 隔离验证：Main（父进程）被强制结束时，被托管的后端进程树是否被回收。
 *
 * 该脚本不使用项目真实数据目录，也不接触用户正在运行的 KumiPlayer：
 * 被托管的"后端"用一条长驻的 `ping` 循环代替，只验证进程树归属与回收。
 *
 * 用法：
 *   node scripts/desktop/p01-helper-orphan-check.cjs
 *
 * 退出码：0 表示受托管进程在预算内被回收；1 表示仍存活（孤儿）。
 */

'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const helper = path.join(
  projectRoot,
  '.build',
  'desktop',
  'helper',
  process.platform === 'win32' ? 'kumiplayer-backend-host.exe' : 'kumiplayer-backend-host',
);

const RECLAIM_BUDGET_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPidFile(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  const pid = Number.parseInt(text, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** 用 `tasklist` 判断进程是否仍存在；不依赖 Node 对已结束句柄的行为。 */
function processAlive(pid) {
  const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  return result.stdout.includes(`"${pid}"`);
}

async function waitForPidFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const pid = readPidFile(file);
      if (pid !== null) {
        return pid;
      }
    }
    await sleep(50);
  }
  return null;
}

/**
 * 父进程角色：启动 helper 托管一条长驻子进程，写出 PID 后立即退出，
 * 不做任何清理——等价于 Main 被强制结束。
 */
async function runHolder(reportFile, mode) {
  if (mode === 'direct') {
    // 对照组：不经过 helper，直接由"Main"启动子进程——
    // 这正是 Node 缺少 Job Object 等价保护的现状，用于证明检查不是恒通过。
    const direct = spawn('ping', ['-n', '600', '127.0.0.1'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    fs.writeFileSync(
      reportFile,
      JSON.stringify({ ok: true, helperPid: direct.pid, hostedPid: direct.pid }),
      'utf8',
    );
    setInterval(() => {}, 1000);
    return;
  }
  const pidFile = `${reportFile}.pid`;
  fs.rmSync(pidFile, { force: true });
  const child = spawn(
    helper,
    [
      '--pid-file', pidFile,
      '--cwd', os.tmpdir(),
      '--',
      'ping', '-n', '600', '127.0.0.1',
    ],
    { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
  );
  let helperStderr = '';
  child.stderr.on('data', (chunk) => {
    helperStderr += String(chunk);
  });
  const hostedPid = await waitForPidFile(pidFile, 10000);
  if (hostedPid === null) {
    fs.writeFileSync(
      reportFile,
      JSON.stringify({ ok: false, reason: 'helper 未写出 PID', stderr: helperStderr }),
      'utf8',
    );
    process.exit(1);
  }
  fs.writeFileSync(
    reportFile,
    JSON.stringify({ ok: true, helperPid: child.pid, hostedPid }),
    'utf8',
  );
  // 保持存活直到被强制终止：helper 的 stdin 管道因此一直开着。
  setInterval(() => {}, 1000);
}

async function runOrchestrator(mode) {
  if (process.platform !== 'win32') {
    console.log('跳过：该验证只针对 Windows 进程树保护');
    process.exit(0);
  }
  if (mode !== 'direct' && !fs.existsSync(helper)) {
    console.error(`未找到进程宿主：${helper}；请先运行 npm run build:helper && npm run stage:helper`);
    process.exit(1);
  }
  const stamp = `${process.pid}-${Date.now()}`;
  const reportFile = path.join(os.tmpdir(), `kumi-p01-${stamp}.json`);
  const holder = spawn(process.execPath, [__filename, '--holder', reportFile, mode], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const report = await (async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (fs.existsSync(reportFile)) {
        return JSON.parse(fs.readFileSync(reportFile, 'utf8'));
      }
      await sleep(100);
    }
    return null;
  })();

  if (!report || report.ok !== true) {
    console.error('未取得被托管进程信息', report);
    process.exit(1);
  }

  // 只终止 holder 自身：Windows 上等价于 TerminateProcess 单个进程，
  // helper 与其托管进程都不在终止范围内。
  try {
    process.kill(holder.pid, 'SIGKILL');
  } catch (error) {
    console.error('未能终止 holder（它可能已退出，测试结论无效）', error);
    process.exit(1);
  }

  const deadline = Date.now() + RECLAIM_BUDGET_MS;
  let alive = true;
  while (Date.now() < deadline) {
    await sleep(100);
    alive = processAlive(report.hostedPid);
    if (!alive) {
      break;
    }
  }

  const elapsed = RECLAIM_BUDGET_MS - Math.max(0, deadline - Date.now());
  fs.rmSync(reportFile, { force: true });
  fs.rmSync(`${reportFile}.pid`, { force: true });

  if (alive) {
    console.error(
      `失败：Main 被强制结束后 ${RECLAIM_BUDGET_MS}ms 内，进程 ${report.hostedPid} 仍然存活`,
    );
    // 清理现场，避免留下孤儿测试进程。
    spawnSync('taskkill', ['/F', '/PID', String(report.hostedPid)], { stdio: 'ignore' });
    process.exit(1);
  }
  console.log(
    `通过（${mode}）：Main 被强制结束后约 ${elapsed}ms，进程 ${report.hostedPid} 已被回收`,
  );
  process.exit(0);
}

const mode = process.argv[2];
if (mode === '--holder') {
  runHolder(process.argv[3], process.argv[4] ?? 'helper').catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  runOrchestrator(mode === '--direct' ? 'direct' : 'helper').catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
