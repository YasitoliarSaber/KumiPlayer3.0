/**
 * 诊断与恢复入口的设备级动作。
 *
 * 只做信息收集与打开日志目录；不清理数据、不改凭据、不启动扫描。
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import type { DesktopStatus } from '@shared/contracts/desktop';

export interface DiagnosticSnapshot {
  readonly appVersion: string;
  readonly electronVersion: string;
  readonly chromeVersion: string;
  readonly status: DesktopStatus;
  readonly logPath: string;
  readonly logExists: boolean;
}

export function collectDiagnostics(status: DesktopStatus): DiagnosticSnapshot {
  const logPath = path.join(status.dataDir, 'logs', 'backend-stderr.log');
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    chromeVersion: process.versions.chrome ?? '',
    status,
    logPath,
    logExists: fs.existsSync(logPath),
  };
}
