/**
 * 演示模式运行时验证。
 *
 * 只在显式设置 `KUMIPLAYER_DESKTOP_MOCK=1` 与 `KUMIPLAYER_DESKTOP_VERIFY=1` 时执行：
 * 依次打开代表性路由，等待页面与图片稳定后截图，并汇总控制台错误与 CSP 违规。
 * 不发起任何网络请求，也不写业务数据。
 */

import { session, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export interface MockVerificationOptions {
  readonly window: BrowserWindow;
  readonly outputDir: string;
  readonly settleMs?: number;
}

export interface MockVerificationReport {
  readonly ok: boolean;
  readonly screenshots: readonly string[];
  /** 各页面实际挂载的作品卡数量，用于证明虚拟化挂载有界。 */
  readonly mountedCards: Readonly<Record<string, number>>;
  /** 各路由渲染出的标题，用于确认截图与页面一致。 */
  readonly routeTitles: Readonly<Record<string, string>>;
  /** 运行期观测到的非受控网络请求（应为空）。 */
  readonly unexpectedRequests: readonly string[];
  /** 桥接模式与业务网关存在性探针结果。 */
  readonly bridgeMode: string;
  readonly businessGatewayCall: string;
  readonly consoleErrors: readonly string[];
  readonly cspViolations: readonly string[];
  readonly missingMarkers: readonly string[];
  readonly failures: readonly string[];
}

interface RouteCheck {
  /** 路由 hash 与稳定标记。 */
  readonly hash: string;
  readonly marker: string;
  readonly name: string;
}

/** 代表性页面：首页、海报墙、收藏、最近观看、详情、媒体管理、设置、播放外壳。 */
const ROUTES: readonly RouteCheck[] = [
  { name: 'home', hash: '#/', marker: '[data-route="home"]' },
  { name: 'library', hash: '#/library/anime_series', marker: '[data-route="library"]' },
  { name: 'favorites', hash: '#/favorites', marker: '[data-route="favorites"]' },
  { name: 'recent', hash: '#/recent', marker: '[data-route="recent"]' },
  { name: 'detail', hash: '#/work/w01-v01', marker: '[data-route="work-detail"]' },
  { name: 'manage', hash: '#/manage', marker: '[data-route="manage"]' },
  { name: 'tasks', hash: '#/tasks', marker: '[data-route="tasks"]' },
  { name: 'settings', hash: '#/settings', marker: '[data-route="settings"]' },
  { name: 'controls', hash: '#/dev/controls', marker: '[data-route="dev"]' },
];

export async function runMockVerification(
  options: MockVerificationOptions,
): Promise<MockVerificationReport> {
  const settleMs = options.settleMs ?? 900;
  const consoleErrors: string[] = [];
  const cspViolations: string[] = [];
  const missingMarkers: string[] = [];
  const failures: string[] = [];
  const screenshots: string[] = [];
  const mountedCards: Record<string, number> = {};
  const routeTitles: Record<string, string> = {};
  const unexpectedRequests: string[] = [];

  // 只允许随包资源与（开发模式的）本地 dev server；其余请求一律记录为异常。
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    const allowed =
      url.startsWith('kumiplayer-app:') ||
      url.startsWith('kumiplayer-artwork:') ||
      url.startsWith('devtools:') ||
      url.startsWith('blob:') ||
      url.startsWith('data:') ||
      /^https?:\/\/127\.0\.0\.1:(1420|5173)\//.test(url);
    if (!allowed) {
      unexpectedRequests.push(url);
    }
    callback({});
  });

  options.window.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      consoleErrors.push(`${event.level}: ${event.message}`);
    }
    if (/Content Security Policy|Refused to (apply|load|execute)/i.test(event.message)) {
      cspViolations.push(event.message);
    }
  });

  fs.mkdirSync(options.outputDir, { recursive: true });

  for (const route of ROUTES) {
    await options.window.webContents.executeJavaScript(
      `location.hash = ${JSON.stringify(route.hash)}; true`,
      true,
    );
    const found = await waitFor(
      options.window,
      `document.querySelector(${JSON.stringify(route.marker)}) !== null`,
      8000,
    );
    if (!found) {
      missingMarkers.push(route.name);
    }
    await waitForImages(options.window, 6000);
    // 等待 DOM 稳定（连续两次读取一致），避免在过渡帧上截图。
    await waitForStableDom(options.window, settleMs);
    mountedCards[route.name] = Number(
      await options.window.webContents.executeJavaScript(
        `document.querySelectorAll('[data-route] button[aria-label^="打开"]').length`,
        true,
      ),
    );
    routeTitles[route.name] = String(
      await options.window.webContents.executeJavaScript(
        `(document.querySelector('[data-route] h1') || document.querySelector('h1') || {}).textContent || ''`,
        true,
      ),
    ).trim();
    const file = path.join(options.outputDir, `${route.name}.png`);
    // 离屏窗口的首帧可能仍是上一路由：丢弃一帧后重新抓取。
    await options.window.webContents.capturePage();
    await delay(300);
    const image = await options.window.webContents.capturePage();
    fs.writeFileSync(file, image.toPNG());
    screenshots.push(file);
  }

  // 桥接模式与业务网关探针：演示模式不应注册任何业务操作处理器。
  const bridgeMode = String(
    await options.window.webContents.executeJavaScript('String(window.kumiplayer?.mode)', true),
  );
  const businessGatewayCall = String(
    await options.window.webContents.executeJavaScript(
      `window.kumiplayer.invoke({ operation: 'library.list', requestId: 'verify-probe' })
        .then(() => 'resolved').catch(() => 'rejected')`,
      true,
    ),
  );

  if (missingMarkers.length > 0) {
    failures.push(`以下页面未渲染：${missingMarkers.join('、')}`);
  }
  if (cspViolations.length > 0) {
    failures.push(`出现 CSP 违规：${cspViolations.slice(0, 3).join(' | ')}`);
  }
  if (bridgeMode !== 'mock') {
    failures.push(`桥接模式不是 mock（实际 ${bridgeMode}）`);
  }
  if (businessGatewayCall !== 'rejected') {
    failures.push('演示模式仍然可以调用业务网关');
  }
  if (unexpectedRequests.length > 0) {
    failures.push(`出现非受控网络请求：${unexpectedRequests.slice(0, 3).join(' | ')}`);
  }
  // 演示库共 240 条作品；海报墙必须只挂载可见窗口内的卡片。
  const libraryCards = mountedCards.library ?? 0;
  if (libraryCards === 0) {
    failures.push('海报墙没有挂载任何作品卡');
  } else if (libraryCards > 100) {
    failures.push(`海报墙挂载卡片过多（${libraryCards}），虚拟化可能失效`);
  }
  const seriousErrors = consoleErrors.filter((message) =>
    /error/i.test(message) && !/favicon/i.test(message),
  );
  if (seriousErrors.length > 0) {
    failures.push(`控制台错误：${seriousErrors.slice(0, 3).join(' | ')}`);
  }

  const report: MockVerificationReport = {
    ok: failures.length === 0,
    screenshots,
    mountedCards,
    routeTitles,
    unexpectedRequests,
    bridgeMode,
    businessGatewayCall,
    consoleErrors,
    cspViolations,
    missingMarkers,
    failures,
  };
  fs.writeFileSync(
    path.join(options.outputDir, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  return report;
}

async function waitFor(
  window: BrowserWindow,
  expression: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (window.isDestroyed()) {
      return false;
    }
    try {
      const value = await window.webContents.executeJavaScript(expression, true);
      if (value === true) {
        return true;
      }
    } catch {
      // 页面仍在导航中，继续等待。
    }
    await delay(120);
  }
  return false;
}

/** 等待当前文档内已插入的图片全部完成解码（带期限）。 */
async function waitForImages(window: BrowserWindow, timeoutMs: number): Promise<void> {
  const expression = `Array.from(document.images).every((image) => image.complete)`;
  await waitFor(window, expression, timeoutMs);
}

/** 连续两次 DOM 文本一致即视为稳定。 */
async function waitForStableDom(window: BrowserWindow, settleMs: number): Promise<void> {
  const expression = `document.body.innerText.length + ':' + document.body.innerText.slice(0, 120)`;
  let previous = '';
  const deadline = Date.now() + Math.max(2400, settleMs * 3);
  while (Date.now() < deadline) {
    const current = String(await window.webContents.executeJavaScript(expression, true));
    if (current === previous) {
      return;
    }
    previous = current;
    await delay(300);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
