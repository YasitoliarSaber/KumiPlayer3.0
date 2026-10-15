/**
 * 本地后端进程监管与生命周期状态机（B 9.2）。
 *
 * 状态：stopped → starting → ready → stopping → stopped；失败进入 failed，
 * 受控重试进入 recovering。所有 start/restart/stop 串行化，同一代次只允许
 * 一个受管后端；端口上已有未知或身份不匹配的监听者时拒绝启动而不复用。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import type { DesktopStatus, BackendPhase, BackendProtection } from '@shared/contracts/desktop';
import type { GatewayError } from '@shared/contracts/errors';
import { parseHealth } from '@shared/contracts/dto';

import {
  BACKEND_HOST,
  HELPER_HANDSHAKE_TIMEOUT_MS,
  HEARTBEAT_FAILURES_BEFORE_RECOVERY,
  HEARTBEAT_INTERVAL_MS,
  HEALTH_POLL_INTERVAL_MS,
  MAX_RECOVERY_ATTEMPTS,
  PORT_RELEASE_TIMEOUT_MS,
  RECOVERY_BACKOFF_MS,
  SHUTDOWN_GRACE_MS,
  STARTUP_TIMEOUT_MS,
} from '../config';
import { backendEnvironment, type RuntimeIdentity } from '../identity';

export interface BackendManagerOptions {
  readonly identity: RuntimeIdentity;
  /** Job Object helper 路径；缺失时退化为 heartbeat-only，并如实上报。 */
  readonly helperPath: string | null;
  readonly projectRoot: string;
  /** 允许注入替身，便于在不起真后端的情况下验证状态机。 */
  readonly spawnImpl?: typeof spawn;
  readonly now?: () => number;
  /** 状态变化回调；Main 只广播状态，不向 Renderer 暴露内部细节。 */
  readonly onStatus?: (status: DesktopStatus) => void;
}

interface ManagedProcess {
  readonly helper: ChildProcess;
  readonly hostedPid: number;
  readonly instanceId: string;
}

export class BackendManager {
  private phase: BackendPhase = 'stopped';
  private epoch = 0;
  private authenticated = false;
  private lastError: GatewayError | undefined;
  private managed: ManagedProcess | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private consecutiveHealthFailures = 0;
  private recoveryAttempts = 0;
  private operation: Promise<void> = Promise.resolve();
  private stopping = false;
  private readonly protection: BackendProtection;
  private readonly spawnImpl: typeof spawn;

  constructor(private readonly options: BackendManagerOptions) {
    this.protection = options.helperPath ? 'job-object-helper' : 'heartbeat-only';
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  status(): DesktopStatus {
    return {
      epoch: this.epoch,
      phase: this.phase,
      protection: this.protection,
      runtimeKind: this.options.identity.kind,
      authenticated: this.authenticated,
      port: this.options.identity.port,
      dataDir: this.options.identity.dataDir,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  get apiToken(): string {
    return this.options.identity.apiToken;
  }

  /** 当前受管后端的宿主 PID（验证与诊断使用，不暴露给 Renderer）。 */
  hostedPid(): number | null {
    return this.managed?.hostedPid ?? null;
  }

  /** 串行化入口：同一时刻只跑一个生命周期动作。 */
  private serialize(action: () => Promise<void>): Promise<void> {
    const next = this.operation.then(action, action);
    this.operation = next.catch(() => undefined);
    return next;
  }

  start(): Promise<void> {
    return this.serialize(() => this.startInternal());
  }

  restart(): Promise<void> {
    return this.serialize(async () => {
      await this.stopInternal();
      this.recoveryAttempts = 0;
      await this.startInternal();
    });
  }

  stop(): Promise<void> {
    return this.serialize(() => this.stopInternal());
  }

  private async startInternal(): Promise<void> {
    if (this.phase === 'ready' && this.managed) {
      return;
    }
    this.setPhase('starting');
    this.stopping = false;

    const existing = await this.readHealthIdentity();
    if (existing === 'incompatible' || existing === 'unknown-listener') {
      this.fail({
        kind: 'conflict',
        message: existing === 'incompatible'
          ? `端口 ${this.options.identity.port} 上已有另一个 KumiPlayer 运行环境，请先关闭它`
          : `端口 ${this.options.identity.port} 已被其他程序占用`,
        retryable: false,
      });
      return;
    }
    if (existing === 'same-identity') {
      this.fail({
        kind: 'conflict',
        message: '当前 KumiPlayer 运行环境已经启动，请使用现有窗口',
        retryable: false,
      });
      return;
    }

    try {
      this.managed = await this.launchManagedBackend();
    } catch (error) {
      this.fail({
        kind: 'unavailable',
        message: error instanceof Error ? error.message : '本地后端无法启动',
        retryable: true,
      });
      return;
    }

    const ready = await this.waitForReady();
    if (!ready) {
      await this.stopInternal();
      this.fail({
        kind: 'unavailable',
        message: `本地后端在 ${Math.round(STARTUP_TIMEOUT_MS / 1000)} 秒内未就绪`,
        retryable: true,
      });
      return;
    }

    this.epoch += 1;
    this.authenticated = true;
    this.lastError = undefined;
    this.consecutiveHealthFailures = 0;
    this.setPhase('ready');
    this.startHeartbeat();
  }

  private async stopInternal(): Promise<void> {
    this.stopping = true;
    this.stopHeartbeat();
    const managed = this.managed;
    this.managed = null;
    this.authenticated = false;
    if (managed) {
      this.setPhase('stopping');
      await this.requestGracefulShutdown();
      await this.reapManaged(managed);
    }
    await this.waitForPortRelease();
    this.setPhase('stopped');
  }

  private async requestGracefulShutdown(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SHUTDOWN_GRACE_MS);
    try {
      await fetch(`http://${BACKEND_HOST}:${this.options.identity.port}/api/system/shutdown`, {
        method: 'POST',
        headers: { 'X-KumiPlayer-Token': this.options.identity.apiToken },
        signal: controller.signal,
      });
    } catch {
      // 后端可能已经退出；这里不掩盖，后续按进程回收结果判定。
    } finally {
      clearTimeout(timer);
    }
  }

  /** 等待被托管进程退出；超期只回收本会话进程树（关闭 helper 的作业句柄）。 */
  private async reapManaged(managed: ManagedProcess): Promise<void> {
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (Date.now() < deadline) {
      if (managed.helper.exitCode !== null || managed.helper.signalCode !== null) {
        return;
      }
      await delay(50);
    }
    if (this.protection === 'job-object-helper') {
      // helper 退出即关闭 kill-on-close 作业句柄，连带回收其后代。
      managed.helper.kill();
    } else {
      // 没有 Job Object 时只能终止直接子进程；后代回收未获保证，状态里已如实标注。
      try {
        process.kill(managed.hostedPid);
      } catch {
        // 进程可能已不存在。
      }
    }
    const hardDeadline = Date.now() + 2000;
    while (Date.now() < hardDeadline) {
      if (managed.helper.exitCode !== null || managed.helper.signalCode !== null) {
        return;
      }
      await delay(50);
    }
  }

  private async waitForPortRelease(): Promise<void> {
    const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!(await isPortInUse(this.options.identity.port))) {
        return;
      }
      await delay(100);
    }
  }

  private async launchManagedBackend(): Promise<ManagedProcess> {
    const identity = this.options.identity;
    if (identity.kind === 'bundled') {
      throw new Error('安装版内置后端尚未接入本轮 Electron 候选');
    }
    const entry = path.join(identity.backendDir, 'desktop_backend.py');
    if (!existsSync(entry)) {
      throw new Error(`未找到后端入口：${entry}`);
    }
    const python = this.findPython();
    if (!python) {
      throw new Error('未找到可用的 Python 3.12 解释器（需要 fastapi/uvicorn 等运行依赖）');
    }

    const logsDir = path.join(identity.dataDir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, 'backend-stderr.log');

    if (this.options.helperPath) {
      const pidFile = path.join(logsDir, `backend-host-${identity.instanceId}.pid`);
      rmSync(pidFile, { force: true });
      const helper = this.spawnImpl(
        this.options.helperPath,
        [
          '--pid-file', pidFile,
          '--log', logPath,
          '--cwd', identity.backendDir,
          '--',
          python,
          'desktop_backend.py',
        ],
        {
          env: backendEnvironment(identity),
          // stdout 不用于通信；stdin 作为“父进程存活”管道，必须保持打开。
          stdio: ['pipe', 'ignore', 'pipe'],
          windowsHide: true,
        },
      );
      const hostedPid = await waitForPidFile(helper, pidFile);
      if (hostedPid === null) {
        helper.kill();
        throw new Error('进程宿主未能接管后端（Job Object 加入失败）');
      }
      this.watchHelperExit(helper);
      return { helper, hostedPid, instanceId: identity.instanceId };
    }

    const direct = this.spawnImpl(python, ['desktop_backend.py'], {
      cwd: identity.backendDir,
      env: backendEnvironment(identity),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    this.watchHelperExit(direct);
    return { helper: direct, hostedPid: direct.pid ?? 0, instanceId: identity.instanceId };
  }

  private watchHelperExit(process_: ChildProcess): void {
    process_.once('exit', () => {
      if (this.stopping) {
        return;
      }
      this.authenticated = false;
      this.lastError = {
        kind: 'unavailable',
        message: '本地后端进程已退出',
        retryable: true,
      };
      this.setPhase('recovering');
      void this.recover();
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatTick();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async heartbeatTick(): Promise<void> {
    if (this.phase !== 'ready') {
      return;
    }
    const healthy = (await this.readHealthIdentity()) === 'same-identity';
    if (healthy) {
      this.consecutiveHealthFailures = 0;
      return;
    }
    this.consecutiveHealthFailures += 1;
    if (this.consecutiveHealthFailures < HEARTBEAT_FAILURES_BEFORE_RECOVERY) {
      return;
    }
    this.authenticated = false;
    this.lastError = { kind: 'unavailable', message: '本地后端心跳失联', retryable: true };
    this.setPhase('recovering');
    await this.recover();
  }

  /** 有限重启：指数退避、次数封顶；失败后停止循环并提供重试入口。 */
  private async recover(): Promise<void> {
    if (this.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      this.setPhase('failed');
      return;
    }
    const backoff = RECOVERY_BACKOFF_MS[Math.min(this.recoveryAttempts, RECOVERY_BACKOFF_MS.length - 1)];
    this.recoveryAttempts += 1;
    await delay(backoff);
    try {
      await this.stopInternal();
      await this.startInternal();
    } catch (error) {
      this.fail({
        kind: 'unavailable',
        message: error instanceof Error ? error.message : '本地后端恢复失败',
        retryable: true,
      });
    }
  }

  private findPython(): string | null {
    for (const candidate of ['pythonw.exe', 'python.exe']) {
      const probe = spawnSync(
        candidate,
        ['-c', 'import fastapi, uvicorn, httpx, multipart, websockets'],
        { stdio: 'ignore', windowsHide: true },
      );
      if (!probe.error && probe.status === 0) {
        return candidate;
      }
    }
    return null;
  }

  /** 已鉴权就绪：先核对 health 身份，再用 Token 读取一次 config。 */
  private async waitForReady(): Promise<boolean> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await this.readHealthIdentity()) === 'same-identity') {
        if (await this.authenticatedProbe()) {
          return true;
        }
      }
      await delay(HEALTH_POLL_INTERVAL_MS);
    }
    return false;
  }

  private async authenticatedProbe(): Promise<boolean> {
    try {
      const response = await fetch(`http://${BACKEND_HOST}:${this.options.identity.port}/api/config`, {
        headers: { 'X-KumiPlayer-Token': this.options.identity.apiToken },
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * 读取端口上的运行身份。
   * `same-identity` 只表示“同一个运行环境已经在跑”，启动流程据此拒绝而不是复用。
   */
  private async readHealthIdentity(): Promise<
    'same-identity' | 'incompatible' | 'unknown-listener' | 'free'
  > {
    let payload: unknown;
    try {
      const response = await fetch(`http://${BACKEND_HOST}:${this.options.identity.port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      payload = (await response.json()) as unknown;
    } catch {
      return (await isPortInUse(this.options.identity.port)) ? 'unknown-listener' : 'free';
    }
    const parsed = parseHealth(payload);
    if (!parsed.ok || parsed.value.app !== 'KumiPlayer') {
      return 'unknown-listener';
    }
    return parsed.value.runtime_id === this.options.identity.runtimeId
      ? 'same-identity'
      : 'incompatible';
  }

  private setPhase(phase: BackendPhase): void {
    this.phase = phase;
    this.options.onStatus?.(this.status());
  }

  private fail(error: GatewayError): void {
    this.lastError = error;
    this.authenticated = false;
    this.setPhase('failed');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: BACKEND_HOST, port });
    const finish = (inUse: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitForPidFile(helper: ChildProcess, pidFile: string): Promise<number | null> {
  const deadline = Date.now() + HELPER_HANDSHAKE_TIMEOUT_MS;
  let stderr = '';
  helper.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  while (Date.now() < deadline) {
    if (helper.exitCode !== null) {
      if (stderr.trim().length > 0) {
        process.stderr.write(`[backend-host] ${stderr.trim()}\n`);
      }
      return null;
    }
    if (existsSync(pidFile)) {
      const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      if (Number.isInteger(pid) && pid > 0) {
        rmSync(pidFile, { force: true });
        return pid;
      }
    }
    await delay(50);
  }
  return null;
}
