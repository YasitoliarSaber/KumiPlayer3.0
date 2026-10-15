#!/usr/bin/env node
/**
 * P01/P02/P04 真实运行验证：在隔离数据目录与独立端口上启动新 Electron 桌面对话，
 * 驱动真实的 Preload → IPC → 网关 → Python 后端链路，并验证两种退出路径。
 *
 * 场景：
 *   graceful   正常退出：先请求鉴权 shutdown，再回收本会话进程树。
 *   force-kill 强制结束：模拟 Main 被杀死，验证后端进程树在预算内被回收。
 *
 * 安全边界：只使用临时数据目录、独立端口（默认 37899）与合成空库；
 * 不接触用户正在运行的 KumiPlayer、项目 data/、凭据或真实媒体。
 */

'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const electronBinary = path.join(
  projectRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);
const mainEntry = path.join(projectRoot, '.build', 'desktop', 'main', 'index.cjs');
const helperBinary = path.join(
  projectRoot,
  '.build',
  'desktop',
  'helper',
  process.platform === 'win32' ? 'kumiplayer-backend-host.exe' : 'kumiplayer-backend-host',
);
const verifyDir = path.join(projectRoot, '.build', 'desktop', 'verify');
const PORT = Number.parseInt(process.env.KUMI_POC_PORT ?? '37899', 10);
const RECLAIM_BUDGET_MS = 6000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid) {
  const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
    encoding: 'utf8',
  });
  return result.stdout.includes(`"${pid}"`);
}

function startDesktop(dataDir, extraEnv) {
  return spawn(electronBinary, [mainEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      KUMIPLAYER_DATA_DIR: dataDir,
      KUMIPLAYER_DESKTOP_PORT: String(PORT),
      KUMIPLAYER_DESKTOP_VERIFY: '1',
      KUMIPLAYER_JOB_HELPER: helperBinary,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim().length > 0) {
      return true;
    }
    await delay(200);
  }
  return false;
}

async function runGraceful(dataDir) {
  fs.rmSync(path.join(verifyDir, 'backend-child-pid.txt'), { force: true });
  const child = startDesktop(dataDir, {});
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve('timeout');
    }, 90_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  const reportFile = path.join(verifyDir, 'report.json');
  const report = fs.existsSync(reportFile)
    ? JSON.parse(fs.readFileSync(reportFile, 'utf8'))
    : null;
  const pidFile = path.join(verifyDir, 'backend-child-pid.txt');
  const backendPid = fs.existsSync(pidFile)
    ? Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
    : null;

  const problems = [];
  if (exitCode !== 0) {
    problems.push(`Electron 退出码 ${exitCode}`);
  }
  if (!report || report.ok !== true) {
    problems.push(`验证报告未通过：${report ? JSON.stringify(report.failures) : '缺少报告'}`);
  }
  if (backendPid && processAlive(backendPid)) {
    problems.push(`正常退出后后端进程 ${backendPid} 仍然存活`);
  }
  return { scenario: 'graceful', ok: problems.length === 0, problems, report, stdout, stderr };
}

async function runForceKill(dataDir) {
  fs.rmSync(path.join(verifyDir, 'backend-child-pid.txt'), { force: true });
  const child = startDesktop(dataDir, { KUMIPLAYER_DESKTOP_VERIFY_HOLD: '1' });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });

  const pidFile = path.join(verifyDir, 'backend-child-pid.txt');
  const ready = await waitForFile(pidFile, 60_000);
  const problems = [];
  if (!ready) {
    problems.push('未取得被托管后端 PID');
    child.kill();
    return { scenario: 'force-kill', ok: false, problems, stdout };
  }
  const backendPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  if (!processAlive(backendPid)) {
    problems.push(`记录的后端进程 ${backendPid} 在强制结束前就已不存在，结论无效`);
    child.kill();
    return { scenario: 'force-kill', ok: false, problems, stdout };
  }

  // 只终止 Electron 主进程，不做任何优雅清理。
  process.kill(child.pid, 'SIGKILL');

  const deadline = Date.now() + RECLAIM_BUDGET_MS;
  let alive = true;
  let elapsedMs = 0;
  while (Date.now() < deadline) {
    await delay(100);
    alive = processAlive(backendPid);
    if (!alive) {
      elapsedMs = RECLAIM_BUDGET_MS - Math.max(0, deadline - Date.now());
      break;
    }
  }
  if (alive) {
    problems.push(`强制结束后 ${RECLAIM_BUDGET_MS}ms 内后端进程 ${backendPid} 仍存活`);
    spawnSync('taskkill', ['/F', '/PID', String(backendPid)], { stdio: 'ignore' });
  }
  // 清理可能残留的 Electron 子进程（GPU/渲染进程），不影响被托管后端。
  spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });

  return {
    scenario: 'force-kill',
    ok: problems.length === 0,
    problems,
    backendPid,
    reclaimMs: alive ? null : elapsedMs,
    stdout,
  };
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('跳过：该验证只针对 Windows 桌面进程树');
    return;
  }
  for (const required of [electronBinary, mainEntry, helperBinary]) {
    if (!fs.existsSync(required)) {
      console.error(`缺少前置产物：${required}`);
      console.error('请先运行 npm run build:desktop');
      process.exit(1);
    }
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kumi-desktop-poc-'));
  const results = [];
  try {
    results.push(await runGraceful(path.join(dataRoot, 'graceful')));
    results.push(await runForceKill(path.join(dataRoot, 'force')));
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }

  let ok = true;
  for (const result of results) {
    ok = ok && result.ok;
    console.log(
      `${result.ok ? '通过' : '失败'} | ${result.scenario}` +
        (result.reclaimMs === undefined ? '' : ` | 回收耗时 ≈ ${result.reclaimMs}ms`),
    );
    for (const problem of result.problems) {
      console.log(`    - ${problem}`);
    }
  }
  const graceful = results[0];
  if (graceful && graceful.report) {
    console.log(
      `报告：phase=${graceful.report.phase} protection=${graceful.report.protection} ` +
        `epoch=${graceful.report.epoch} 探针可见=${graceful.report.authenticatedProbeVisible} ` +
        `CSP违规=${graceful.report.cspViolations.length}`,
    );
    console.log(`截图：${path.relative(projectRoot, graceful.report.screenshot)}`);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
