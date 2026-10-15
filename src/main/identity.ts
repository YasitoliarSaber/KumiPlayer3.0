/**
 * 本次桌面会话的运行身份。
 *
 * 与现有 Tauri 壳保持同一合同：每次启动生成新的随机会话 Token 与实例号，
 * `runtime_id` 由运行模式与安装根推导，不接受外部传入。
 * Token 只留在 Main，不进入 Renderer、Query 键、日志或 URL。
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface RuntimeIdentity {
  readonly kind: 'source' | 'bundled';
  readonly installRoot: string;
  readonly backendDir: string;
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly apiToken: string;
  readonly dataDir: string;
  readonly port: number;
}

/**
 * 定位项目根：从候选起点向上寻找 `backend/app/main.py`。
 * 找不到时返回 null，由调用方给出明确失败，而不是猜一个目录继续。
 */
export function findProjectRoot(start: string): string | null {
  let current = path.resolve(start);
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(path.join(current, 'backend', 'app', 'main.py'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
}

/**
 * 与 Rust `runtime_identity::runtime_id_for` 等价的身份哈希：
 * 运行模式 + 规范化安装根，用于拒绝源码版与安装版互用同端口。
 */
export function runtimeIdFor(kind: string, installRoot: string): string {
  const normalized = path.resolve(installRoot).replace(/\\/g, '/').toLowerCase();
  return createHash('sha256').update(`${kind}\u0000${normalized}`).digest('hex').slice(0, 32);
}

export function generateApiToken(): string {
  return randomBytes(32).toString('hex');
}

export function generateInstanceId(): string {
  return `${process.pid}-${randomBytes(6).toString('hex')}`;
}

export interface IdentityInputs {
  /** 安装根（源码模式为项目根）。 */
  readonly installRoot: string;
  readonly kind: 'source' | 'bundled';
  readonly port: number;
  readonly dataDirOverride?: string | undefined;
}

export function createIdentity(inputs: IdentityInputs): RuntimeIdentity {
  const installRoot = path.resolve(inputs.installRoot);
  const dataDir = inputs.dataDirOverride
    ? path.resolve(inputs.dataDirOverride)
    : path.join(installRoot, 'data');
  return {
    kind: inputs.kind,
    installRoot,
    backendDir: path.join(installRoot, 'backend'),
    runtimeId: runtimeIdFor(inputs.kind, installRoot),
    instanceId: generateInstanceId(),
    apiToken: generateApiToken(),
    dataDir,
    port: inputs.port,
  };
}

/** 注入给后端的运行环境；与现有桌面壳逐项对齐。 */
export function backendEnvironment(identity: RuntimeIdentity): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KUMIPLAYER_HOST: '127.0.0.1',
    KUMIPLAYER_PORT: String(identity.port),
    KUMIPLAYER_RUNTIME_DIR: identity.installRoot,
    KUMIPLAYER_DATA_DIR: identity.dataDir,
    KUMIPLAYER_RUNTIME_KIND: identity.kind,
    KUMIPLAYER_RUNTIME_ID: identity.runtimeId,
    KUMIPLAYER_INSTANCE_ID: identity.instanceId,
    KUMIPLAYER_API_TOKEN: identity.apiToken,
    KUMIPLAYER_PARENT_PID: String(process.pid),
    KUMIPLAYER_AUTO_SHUTDOWN_ON_HEARTBEAT_TIMEOUT: '1',
    KUMIPLAYER_HEARTBEAT_TIMEOUT: '120',
  };
}
