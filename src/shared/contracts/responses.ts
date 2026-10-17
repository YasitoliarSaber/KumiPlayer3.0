/**
 * 响应解析注册表与 HTTP 失败语义映射。
 *
 * 响应在唯一可信入口（Main 网关）按本表验证一次，Renderer 只消费已验证结果。
 * FastAPI 路由当前没有显式 response_model，因此解析器是手写契约；
 * 未登记的响应形状不得用 any 或断言放行。
 */

import type { GatewayError, GatewayErrorKind, GatewayValidationIssue } from './errors';
import { isRetryableKind } from './errors';
import type { OperationId } from './operations';
import {
  parseBangumiCollectionSet,
  parseBangumiMatch,
  parseBangumiMatchRemoved,
  parseBangumiProgressSync,
  parseBangumiSession,
  parseBangumiSubjectSearch,
  parseBangumiTokenResult,
  parseHealth,
  parseLibraryChanges,
  parseLibrarySnapshot,
  parseOpenFolderResult,
  parsePlaybackStatus,
  parsePublicConfig,
  parseTask,
  parseTaskList,
  parseWorkDeletePreview,
  parseWorkDeleteResult,
  parseWorkDetail,
  parseWorkFolderInfo,
  parseWorkScrapeResult,
  type BangumiCollectionSet,
  type BangumiMatch,
  type BangumiMatchRemoved,
  type BangumiProgressSync,
  type BangumiSession,
  type BangumiSubjectSearch,
  type BangumiTokenResult,
  type LibraryChanges,
  type LibrarySnapshot,
  type OpenFolderResult,
  type PlaybackStatus,
  type PublicConfig,
  type TaskList,
  type TaskRecord,
  type WorkDeletePreview,
  type WorkDeleteResult,
  type WorkDetail,
  type WorkFolderInfo,
  type WorkScrapeResult,
  type HealthResponse,
} from './dto';
import type { Reader } from './validate';
import { boolean, field, objectWith, string } from './validate';

/** 已登记操作的响应形状。只登记本轮实际消费的端点。 */
export interface ResponseShapes {
  readonly 'health.get': HealthResponse;
  readonly 'config.get': PublicConfig;
  /** 首次引导的三个写端点都返回同一份脱敏配置。 */
  readonly 'config.setupDefer': PublicConfig;
  readonly 'config.setupComplete': PublicConfig;
  readonly 'config.setupTmdbCredential': PublicConfig;
  readonly 'library.list': LibrarySnapshot;
  readonly 'library.changes': LibraryChanges;
  readonly 'library.cards': { readonly works: readonly unknown[] };
  readonly 'work.detail': WorkDetail;
  readonly 'tasks.list': TaskList;
  readonly 'tasks.get': TaskRecord;
  readonly 'tasks.cancel': TaskRecord;
  readonly 'playback.status': PlaybackStatus;
  readonly 'work.title.set': WorkTitleSet;
  readonly 'work.title.restore': WorkTitleRestored;
  readonly 'work.folder': WorkFolderInfo;
  readonly 'work.scrape': WorkScrapeResult;
  readonly 'work.deletePreview': WorkDeletePreview;
  readonly 'work.deleteConfirm': WorkDeleteResult;
  readonly 'system.openFolder': OpenFolderResult;
  readonly 'bangumi.session': BangumiSession;
  readonly 'bangumi.sessionVerify': BangumiSession;
  readonly 'bangumi.token.set': BangumiTokenResult;
  readonly 'bangumi.token.clear': BangumiTokenResult;
  readonly 'bangumi.search': BangumiSubjectSearch;
  readonly 'bangumi.match.get': BangumiMatch;
  readonly 'bangumi.match.set': BangumiMatch;
  readonly 'bangumi.match.remove': BangumiMatchRemoved;
  readonly 'bangumi.collection.set': BangumiCollectionSet;
  readonly 'bangumi.progress.sync': BangumiProgressSync;
}

/** `PATCH /api/v4/works/{work_id}/title`（`backend/app/api/media_v4.py:2195-2221`）。 */
export interface WorkTitleSet {
  readonly work_id: string;
  readonly title: string;
}

const workTitleSetReader: Reader<WorkTitleSet> = objectWith<WorkTitleSet>({
  work_id: field(string(), true),
  title: field(string()),
});

/** `DELETE /api/v4/works/{work_id}/title`（`backend/app/api/media_v4.py:2224-2237`）。 */
export interface WorkTitleRestored {
  readonly work_id: string;
  readonly restored: boolean;
}

const workTitleRestoredReader: Reader<WorkTitleRestored> = objectWith<WorkTitleRestored>({
  work_id: field(string(), true),
  restored: field(boolean(), true),
});

function cardsReader(value: unknown): ReturnType<Reader<{ works: readonly unknown[] }>> {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, issues: ['期望对象'] };
  }
  const works = (value as { works?: unknown }).works;
  if (!Array.isArray(works)) {
    return { ok: false, issues: ['works 期望数组'] };
  }
  return { ok: true, value: { works } };
}

export const OPERATION_RESPONSE_PARSERS: {
  readonly [K in keyof ResponseShapes]: Reader<ResponseShapes[K]>;
} = {
  'health.get': parseHealth,
  'config.get': parsePublicConfig,
  'config.setupDefer': parsePublicConfig,
  'config.setupComplete': parsePublicConfig,
  'config.setupTmdbCredential': parsePublicConfig,
  'library.list': parseLibrarySnapshot,
  'library.changes': parseLibraryChanges,
  'library.cards': cardsReader,
  'work.detail': parseWorkDetail,
  'tasks.list': parseTaskList,
  'tasks.get': parseTask,
  'tasks.cancel': parseTask,
  'playback.status': parsePlaybackStatus,
  'work.title.set': workTitleSetReader,
  'work.title.restore': workTitleRestoredReader,
  'work.folder': parseWorkFolderInfo,
  'work.scrape': parseWorkScrapeResult,
  'work.deletePreview': parseWorkDeletePreview,
  'work.deleteConfirm': parseWorkDeleteResult,
  'system.openFolder': parseOpenFolderResult,
  'bangumi.session': parseBangumiSession,
  'bangumi.sessionVerify': parseBangumiSession,
  'bangumi.token.set': parseBangumiTokenResult,
  'bangumi.token.clear': parseBangumiTokenResult,
  'bangumi.search': parseBangumiSubjectSearch,
  'bangumi.match.get': parseBangumiMatch,
  'bangumi.match.set': parseBangumiMatch,
  'bangumi.match.remove': parseBangumiMatchRemoved,
  'bangumi.collection.set': parseBangumiCollectionSet,
  'bangumi.progress.sync': parseBangumiProgressSync,
};

/** 收窄到"已登记响应形状"的操作，避免在网关里用类型断言索引解析表。 */
export function hasResponseParser(
  operation: OperationId,
): operation is Extract<OperationId, keyof ResponseShapes> {
  return Object.prototype.hasOwnProperty.call(OPERATION_RESPONSE_PARSERS, operation);
}

export function httpStatusToKind(status: number): GatewayErrorKind {
  if (status === 401 || status === 403) {
    return 'auth';
  }
  if (status === 409) {
    return 'conflict';
  }
  if (status === 503) {
    return 'unavailable';
  }
  if (status >= 500) {
    return 'internal';
  }
  if (status >= 400) {
    return 'validation';
  }
  return 'protocol';
}

/**
 * FastAPI 的 `detail` 既可能是字符串，也可能是校验错误列表。
 * 这里保留真实语义：列表进入 `details`，不拼成字符串。
 */
export function interpretFailurePayload(
  status: number,
  payload: unknown,
): GatewayError {
  const kind = httpStatusToKind(status);
  const detail = extractDetail(payload);
  const message = detail.message || `后端返回 HTTP ${status}`;
  return {
    kind,
    status,
    message,
    ...(detail.code ? { code: detail.code } : {}),
    ...(detail.issues.length > 0 ? { details: detail.issues } : {}),
    retryable: isRetryableKind(kind),
  };
}

interface DetailParts {
  readonly message: string;
  readonly code: string;
  readonly issues: readonly GatewayValidationIssue[];
}

function extractDetail(payload: unknown): DetailParts {
  if (typeof payload === 'string') {
    return { message: payload, code: '', issues: [] };
  }
  if (typeof payload !== 'object' || payload === null) {
    return { message: '', code: '', issues: [] };
  }
  const record = payload as { detail?: unknown; code?: unknown };
  const code = typeof record.code === 'string' ? record.code : '';
  if (typeof record.detail === 'string') {
    return { message: record.detail, code, issues: [] };
  }
  if (Array.isArray(record.detail)) {
    const issues: GatewayValidationIssue[] = [];
    for (const entry of record.detail) {
      if (typeof entry !== 'object' || entry === null) {
        continue;
      }
      const item = entry as { loc?: unknown; msg?: unknown; type?: unknown };
      issues.push({
        location: Array.isArray(item.loc) ? item.loc.map(String).join('.') : '',
        message: typeof item.msg === 'string' ? item.msg : '',
        type: typeof item.type === 'string' ? item.type : '',
      });
    }
    return { message: issues[0]?.message ?? '', code, issues };
  }
  return { message: '', code, issues: [] };
}

export function protocolFailure(message: string, retryable = false): GatewayError {
  return { kind: 'protocol', message, retryable };
}
