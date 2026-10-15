/**
 * Electron 主进程入口（P01/P02 候选）。
 *
 * 职责边界：窗口与安全策略、后端进程监管、唯一 HTTP 网关、具名 IPC、
 * 受限图片协议与恢复入口。媒体业务判断全部留在 Python 后端。
 */

import { app, BrowserWindow, protocol, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { APP_PROTOCOL, ARTWORK_PROTOCOL, type DesktopStatus } from '@shared/contracts/desktop';

import { resolveBackendPort } from './config';
import { BackendGateway } from './backend/gateway';
import { BackendManager } from './backend/manager';
import { createIdentity, findProjectRoot } from './identity';
import { broadcastStatus, registerBridgeIpc } from './ipc/handlers';
import { registerWindowControls } from './ipc/window-controls';
import { installMockProfile, isMockMode, mockAssetRoot } from './mock-mode';
import { registerAppProtocol } from './protocols/app-protocol';
import { registerArtworkProtocol } from './protocols/artwork';
import { createMainWindow, installPermissionPolicy } from './windows/main-window';

const windows: BrowserWindow[] = [];

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
  {
    scheme: ARTWORK_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [existing] = windows;
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) {
        existing.restore();
      }
      existing.focus();
    }
  });
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  installPermissionPolicy(session.defaultSession);

  const projectRoot = findProjectRoot(app.getAppPath()) ?? findProjectRoot(process.cwd());
  if (!projectRoot) {
    failFast('未定位到项目根目录（缺少 backend/app/main.py）');
    return;
  }

  if (isMockMode()) {
    await bootstrapMock(projectRoot);
    return;
  }

  const identity = createIdentity({
    installRoot: projectRoot,
    kind: 'source',
    port: resolveBackendPort(),
    dataDirOverride: process.env.KUMIPLAYER_DATA_DIR,
  });

  const rendererRoot = path.join(__dirname, '..', 'renderer');
  registerAppProtocol({ rendererRoot });
  registerArtworkProtocol({ port: () => identity.port, token: () => identity.apiToken });

  const gateway = new BackendGateway({
    context: () => ({ port: identity.port, token: identity.apiToken, epoch: manager.status().epoch }),
  });

  const manager: BackendManager = new BackendManager({
    identity,
    projectRoot,
    helperPath: resolveHelperPath(projectRoot),
    onStatus: (status) => broadcastStatus(windows.map((window) => window.webContents), status),
  });

  registerBridgeIpc({
    gateway,
    manager,
    listWindows: () => windows.map((window) => window.webContents),
  });

  installCrashRecovery(manager);

  const window = createMainWindow({
    preloadPath: path.join(__dirname, '..', 'preload', 'index.cjs'),
    devServerUrl: process.env.ELECTRON_RENDERER_URL,
    autoShow: true,
    frameless: true,
    offscreenVerify: process.env.KUMIPLAYER_DESKTOP_VERIFY === '1',
  });
  windows.push(window);
  registerWindowControls(() => windows.map((item) => item.webContents));
  window.on('closed', () => {
    const index = windows.indexOf(window);
    if (index >= 0) {
      windows.splice(index, 1);
    }
  });

  await manager.start();

  if (process.env.KUMIPLAYER_DESKTOP_VERIFY === '1') {
    const verifyDir = path.join(projectRoot, '.build', 'desktop', 'verify');
    const { runDesktopVerification } = await import('./verify/desktop-verification');
    fs.mkdirSync(verifyDir, { recursive: true });
    const report = await runDesktopVerification({
      window,
      manager,
      reportPath: path.join(verifyDir, 'report.json'),
      screenshotPath: path.join(verifyDir, 'session-page.png'),
    });
    fs.writeFileSync(
      path.join(verifyDir, 'backend-child-pid.txt'),
      String(manager.hostedPid() ?? ''),
      'utf8',
    );
    process.stdout.write(`[verify] ok=${report.ok} phase=${report.phase}\n`);
    if (report.failures.length > 0) {
      process.stdout.write(`[verify] failures=${report.failures.join(' | ')}\n`);
    }
    if (process.env.KUMIPLAYER_DESKTOP_VERIFY_HOLD === '1') {
      // 保持运行，让外部检查者模拟"Main 被强制结束"并观察进程树回收。
      process.stdout.write(`[verify] holding backend pid=${manager.hostedPid() ?? ''}\n`);
      setInterval(() => undefined, 1000);
      return;
    }
    await manager.stop();
    app.exit(report.ok ? 0 : 1);
    return;
  }

  app.on('window-all-closed', () => {
    app.quit();
  });

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) {
      return;
    }
    event.preventDefault();
    quitting = true;
    void manager.stop().finally(() => {
      app.quit();
    });
  });
}

/**
 * 演示模式启动：不创建 BackendManager、不启动 Python/helper、
 * 不注册业务网关与图片网关，只加载随包的 Renderer 与本地演示素材。
 */
async function bootstrapMock(projectRoot: string): Promise<void> {
  const profileDir = installMockProfile(app, projectRoot);
  const assetRoot = mockAssetRoot(projectRoot);
  const rendererRoot = path.join(__dirname, '..', 'renderer');
  registerAppProtocol({
    rendererRoot,
    extraMounts: assetRoot ? [{ prefix: '/__mock/', root: assetRoot }] : [],
  });

  const window = createMainWindow({
    preloadPath: path.join(__dirname, '..', 'preload', 'index.cjs'),
    devServerUrl: process.env.ELECTRON_RENDERER_URL,
    autoShow: true,
    // 演示模式与正式模式一致：无边框窗口 + 自绘标题栏，
    // 否则会同时出现系统标题栏与自绘标题栏。
    frameless: true,
    offscreenVerify: process.env.KUMIPLAYER_DESKTOP_VERIFY === '1',
  });
  windows.push(window);
  // 自绘标题栏依赖窗口控制；两个模式都注册，且只对受信窗口生效。
  registerWindowControls(() => windows.map((item) => item.webContents));

  process.stdout.write(
    `[mock] 演示模式已启动：未启动 Python 后端、未注册业务网关；profile=${profileDir}\n`,
  );
  if (!assetRoot) {
    process.stdout.write(
      '[mock] 警告：未找到演示素材目录，界面将显示占位图。请先运行 npm run mock:assets\n',
    );
  }

  if (process.env.KUMIPLAYER_DESKTOP_VERIFY === '1') {
    const verifyDir = path.join(projectRoot, '.build', 'desktop', 'verify', 'mock');
    const { runMockVerification } = await import('./verify/mock-verification');
    const report = await runMockVerification({ window, outputDir: verifyDir });
    process.stdout.write(`[mock-verify] ok=${report.ok}\n`);
    for (const problem of report.failures) {
      process.stdout.write(`[mock-verify] 失败：${problem}\n`);
    }
    process.stdout.write(
      `[mock-verify] 截图 ${report.screenshots.length} 张 → ${verifyDir}\n`,
    );
    app.exit(report.ok ? 0 : 1);
    return;
  }

  app.on('window-all-closed', () => {
    app.quit();
  });
}

/**
 * Job Object helper 只在源码构建产物中存在；缺失时后端仍可启动，
 * 但保护模式会如实上报为 heartbeat-only，不会被当成 Job Object 等价物。
 */
function resolveHelperPath(projectRoot: string): string | null {
  const override = process.env.KUMIPLAYER_JOB_HELPER;
  if (override && fs.existsSync(override)) {
    return override;
  }
  const staged = path.join(
    projectRoot,
    '.build',
    'desktop',
    'helper',
    process.platform === 'win32' ? 'kumiplayer-backend-host.exe' : 'kumiplayer-backend-host',
  );
  return fs.existsSync(staged) ? staged : null;
}

/** Renderer 崩溃不重启后端：任务与播放所有权仍在 Python/Main。 */
function installCrashRecovery(manager: BackendManager): void {
  app.on('render-process-gone', (_event, _contents, details) => {
    process.stderr.write(`[renderer] 进程异常结束：${details.reason}\n`);
  });
  app.on('child-process-gone', (_event, details) => {
    process.stderr.write(`[child-process] 异常结束：${details.type} ${details.reason}\n`);
  });
  process.on('uncaughtException', (error) => {
    process.stderr.write(`[main] 未捕获异常：${error.message}\n`);
  });
  void manager;
}

function failFast(message: string): void {
  const status: DesktopStatus = {
    epoch: 0,
    phase: 'failed',
    protection: 'heartbeat-only',
    runtimeKind: 'source',
    authenticated: false,
    port: 0,
    dataDir: '',
    lastError: { kind: 'internal', message, retryable: false },
  };
  broadcastStatus(windows.map((window) => window.webContents), status);
  process.stderr.write(`[main] ${message}\n`);
  app.quit();
}
