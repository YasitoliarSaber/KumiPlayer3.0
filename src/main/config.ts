/**
 * 桌面主进程的集中常量。
 *
 * 所有超时、端口与退避都集中在这里，避免散落在各处字面量里。
 * 这些值是 P01 的实验起点，不是已实测结论。
 */

export const BACKEND_HOST = '127.0.0.1';

/** 与现有 Tauri 壳一致的固定端口。 */
export const DEFAULT_BACKEND_PORT = 37821;

/** 启动期等待健康 + 鉴权就绪的总期限。 */
export const STARTUP_TIMEOUT_MS = 30_000;
export const HEALTH_POLL_INTERVAL_MS = 500;

/** Main 侧心跳：只观察，不代替后端自身的心跳兜底。 */
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_FAILURES_BEFORE_RECOVERY = 3;

/** 有限重启：禁止无上限重启循环。 */
export const MAX_RECOVERY_ATTEMPTS = 3;
export const RECOVERY_BACKOFF_MS: readonly number[] = [1_000, 3_000, 8_000];

/** 正常退出：先请求既有鉴权 shutdown，再在预算内回收本会话进程树。 */
export const SHUTDOWN_GRACE_MS = 5_000;
export const PORT_RELEASE_TIMEOUT_MS = 3_000;

/** 等待 Job Object helper 写出子进程 PID 的期限。 */
export const HELPER_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * 隔离验证用端口覆盖。仅供源码模式的本机隔离 PoC 使用：
 * 现场可能存在用户正在运行的应用，验证不得占用它的端口。
 */
export function resolveBackendPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KUMIPLAYER_DESKTOP_PORT;
  if (!raw) {
    return DEFAULT_BACKEND_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    return DEFAULT_BACKEND_PORT;
  }
  return parsed;
}
