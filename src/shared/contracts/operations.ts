/**
 * 具名操作白名单（B §5.1，ADR-04）。
 *
 * 这是 Renderer 能触达后端的**全部**能力面。Main 只按本表映射到既有 Python HTTP
 * 端点；Renderer 不能提供 URL、method、channel，也不能执行任意命令。
 * 新增能力必须在此登记，并同时补契约测试。
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface HttpOperationSpec {
  readonly transport: 'http';
  readonly kind: 'read' | 'mutation';
  readonly method: HttpMethod;
  /** 用 `:name` 表示路径参数；参数值不得包含分隔符。 */
  readonly path: string;
  /** 允许转发的查询参数名；未登记的参数一律拒绝。 */
  readonly query: readonly string[];
  /** 允许转发的 JSON 请求体字段；未登记的字段一律拒绝。 */
  readonly body: readonly string[];
  readonly timeoutMs: number;
}

export interface LocalCommandSpec {
  readonly transport: 'local';
  readonly kind: 'command' | 'read';
  readonly timeoutMs: number;
}

export type OperationSpec = HttpOperationSpec | LocalCommandSpec;

/** 读取类操作的默认期限；确认、播放等 mutation 由调用方显式给出更长期限。 */
const READ_TIMEOUT_MS = 15_000;
const MUTATION_TIMEOUT_MS = 60_000;

export const OPERATION_SPECS = {
  /** 桌面自身状态：后端代次、就绪状态、保护模式。不经 HTTP。 */
  'desktop.status': { transport: 'local', kind: 'read', timeoutMs: 5_000 },
  /** 重启本地后端；串行化，不取消已受理任务。 */
  'desktop.restartBackend': { transport: 'local', kind: 'command', timeoutMs: 45_000 },
  /** 打开诊断日志目录。 */
  'desktop.openLogs': { transport: 'local', kind: 'command', timeoutMs: 5_000 },
  /** 收集脱敏诊断快照（不含 Token、凭据与私人路径）。 */
  'desktop.diagnostics': { transport: 'local', kind: 'read', timeoutMs: 10_000 },

  /** 公开健康检查：只用于身份匹配，不携带令牌，也不代表业务就绪。 */
  'health.get': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/health',
    query: [],
    body: [],
    timeoutMs: 5_000,
  },
  'config.get': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/config',
    query: [],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'library.list': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/library',
    query: ['source', 'work_ids'],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'library.changes': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/library/changes',
    query: ['after', 'limit'],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'library.cards': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/library/cards',
    query: ['work_ids'],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'work.detail': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/library/works/:workId',
    query: [],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'tasks.list': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/tasks',
    query: ['source', 'task_type', 'type_prefix', 'limit'],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'tasks.get': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/tasks/:taskId',
    query: [],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'tasks.cancel': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/tasks/:taskId/cancel',
    query: [],
    body: [],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'playback.status': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/playback/status',
    query: [],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
} as const satisfies Record<string, OperationSpec>;

export type OperationId = keyof typeof OPERATION_SPECS;

export interface OperationRequest {
  readonly operation: OperationId;
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly body?: Readonly<Record<string, unknown>>;
  /** Renderer 生成的请求标识，用于取消与旧结果隔离。 */
  readonly requestId: string;
}

const PATH_PARAM_PATTERN = /^:[A-Za-z][A-Za-z0-9]*$/;
const PARAM_VALUE_PATTERN = /^[A-Za-z0-9._:-]+$/;

export interface ResolvedHttpTarget {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query: ReadonlyArray<readonly [string, string]>;
}

export type TargetResolution =
  | { readonly ok: true; readonly target: ResolvedHttpTarget }
  | { readonly ok: false; readonly reason: string };

/**
 * 把已登记的具名操作解析成固定 HTTP 目标。
 * 任何未登记的操作、参数或取值都会在这里被拒绝，不进入 HTTP 层。
 */
export function resolveHttpTarget(
  request: OperationRequest,
): TargetResolution {
  const spec: OperationSpec | undefined = OPERATION_SPECS[request.operation];
  if (!spec) {
    return { ok: false, reason: `未登记的操作：${String(request.operation)}` };
  }
  if (spec.transport !== 'http') {
    return { ok: false, reason: `${request.operation} 不是 HTTP 操作` };
  }

  const params = request.params ?? {};
  const segments = spec.path.split('/').map((segment) => {
    if (!PATH_PARAM_PATTERN.test(segment)) {
      return segment;
    }
    const name = segment.slice(1);
    const value = params[name];
    return value ?? '';
  });
  const missing = spec.path
    .split('/')
    .filter((segment) => PATH_PARAM_PATTERN.test(segment))
    .map((segment) => segment.slice(1))
    .filter((name) => !PARAM_VALUE_PATTERN.test(params[name] ?? ''));
  if (missing.length > 0) {
    return { ok: false, reason: `路径参数非法或缺失：${missing.join(', ')}` };
  }
  const knownParams = new Set(
    spec.path
      .split('/')
      .filter((segment) => PATH_PARAM_PATTERN.test(segment))
      .map((segment) => segment.slice(1)),
  );
  for (const name of Object.keys(params)) {
    if (!knownParams.has(name)) {
      return { ok: false, reason: `未登记的路径参数：${name}` };
    }
  }

  const query: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(request.query ?? {})) {
    if (!spec.query.includes(name)) {
      return { ok: false, reason: `未登记的查询参数：${name}` };
    }
    const text = String(value);
    if (text.length > 4096) {
      return { ok: false, reason: `查询参数过长：${name}` };
    }
    query.push([name, text]);
  }
  for (const name of Object.keys(request.body ?? {})) {
    if (!spec.body.includes(name)) {
      return { ok: false, reason: `未登记的请求字段：${name}` };
    }
  }
  if (spec.method === 'GET' && request.body && Object.keys(request.body).length > 0) {
    return { ok: false, reason: `${request.operation} 不接受请求体` };
  }

  return { ok: true, target: { method: spec.method, path: segments.join('/'), query } };
}

export function operationSpec(operation: OperationId): OperationSpec {
  return OPERATION_SPECS[operation];
}

export const OPERATION_IDS = Object.keys(OPERATION_SPECS) as readonly OperationId[];
