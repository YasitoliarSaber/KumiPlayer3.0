/**
 * 隔离运行时验证（P01/P02/P04 的真实运行证据收集）。
 *
 * 只有显式设置 `KUMIPLAYER_DESKTOP_VERIFY=1` 时才会执行：
 * 使用隔离数据目录与独立端口，加载真实构建产物，驱动真实的
 * Preload → IPC → 网关 → Python 后端链路，并把可复核证据写入报告。
 *
 * 它不改变产品行为，也不打包、不发布。
 */

import type { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import type { DesktopStatus } from '@shared/contracts/desktop';

import type { BackendManager } from '../backend/manager';

export interface VerificationOptions {
  readonly window: BrowserWindow;
  readonly manager: BackendManager;
  readonly reportPath: string;
  readonly screenshotPath: string;
  readonly timeoutMs?: number;
}

export interface VerificationReport {
  readonly ok: boolean;
  readonly phase: string;
  readonly protection: string;
  readonly epoch: number;
  readonly port: number;
  readonly loadedUrl: string;
  readonly authenticatedProbeVisible: boolean;
  readonly domExcerpt: string;
  readonly consoleErrors: readonly string[];
  readonly cspViolations: readonly string[];
  readonly screenshot: string;
  readonly warnings: readonly string[];
  readonly failures: readonly string[];
}

const VERIFY_TIMEOUT_MS = 45_000;

export async function runDesktopVerification(
  options: VerificationOptions,
): Promise<VerificationReport> {
  const timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const consoleErrors: string[] = [];
  const cspViolations: string[] = [];
  const warnings: string[] = [];

  options.window.webContents.on('console-message', (event) => {
    const message = `${event.level}: ${event.message}`;
    if (event.level === 'error' || event.level === 'warning') {
      consoleErrors.push(message);
    }
    if (/Content Security Policy|Refused to (apply|load|execute)/i.test(event.message)) {
      cspViolations.push(event.message);
    }
  });

  const deadline = Date.now() + timeoutMs;
  let domText = '';
  let probeVisible = false;
  while (Date.now() < deadline) {
    try {
      domText = String(
        await options.window.webContents.executeJavaScript('document.body.innerText', true),
      );
    } catch {
      domText = '';
    }
    if (domText.includes('health.app')) {
      probeVisible = true;
      break;
    }
    await delay(500);
  }

  const status: DesktopStatus = options.manager.status();
  const failures: string[] = [];
  if (status.phase !== 'ready') {
    failures.push(`后端未就绪：${status.phase}`);
  }
  if (!status.authenticated) {
    failures.push('后端未通过鉴权就绪探针');
  }
  if (!probeVisible) {
    failures.push('界面未渲染已鉴权读取结果（Preload/IPC/网关链路未闭环）');
  }
  if (cspViolations.length > 0) {
    failures.push(`出现 CSP 违规：${cspViolations.slice(0, 3).join(' | ')}`);
  }

  fs.mkdirSync(path.dirname(options.screenshotPath), { recursive: true });
  let screenshotPath = '';
  try {
    const image = await options.window.webContents.capturePage();
    fs.writeFileSync(options.screenshotPath, image.toPNG());
    screenshotPath = options.screenshotPath;
  } catch (error) {
    warnings.push(`截图未取得：${error instanceof Error ? error.message : String(error)}`);
  }

  const report: VerificationReport = {
    ok: failures.length === 0,
    phase: status.phase,
    protection: status.protection,
    epoch: status.epoch,
    port: status.port,
    loadedUrl: options.window.webContents.getURL(),
    authenticatedProbeVisible: probeVisible,
    domExcerpt: domText.slice(0, 1200),
    consoleErrors,
    cspViolations,
    screenshot: screenshotPath,
    warnings,
    failures,
  };
  fs.mkdirSync(path.dirname(options.reportPath), { recursive: true });
  fs.writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
