/**
 * 后端真实响应 DTO 的 TypeScript 形状 + 运行时校验。
 *
 * 证据来源：`backend/app/api/library_v4.py`、`tasks_v4.py`、`playback_v4.py`、
 * `config.py`、`main.py` 的当前实现，以及本轮在隔离数据目录下实际抓取的响应夹具
 * （见 `tests/desktop/fixtures/`）。FastAPI 路由没有显式 response_model，
 * 所以这里的形状只能由真实响应与源码共同证明，不允许用 any 或断言掩盖缺口。
 */

import {
  arrayOf,
  boolean,
  field,
  isRecord,
  nullable,
  number,
  objectWith,
  string,
  type Reader,
  type Validation,
  invalid,
  valid,
} from './validate';

/* ------------------------------------------------------------------ */
/* /api/health                                                         */
/* ------------------------------------------------------------------ */

export interface HealthResponse {
  readonly status: string;
  readonly app: string;
  readonly runtime_kind: string;
  readonly runtime_id: string;
  readonly instance_id: string;
}

export const parseHealth: Reader<HealthResponse> = objectWith<HealthResponse>({
  status: field(string()),
  app: field(string()),
  runtime_kind: field(string(), true),
  runtime_id: field(string(), true),
  instance_id: field(string(), true),
});

/* ------------------------------------------------------------------ */
/* /api/library                                                        */
/* ------------------------------------------------------------------ */

export type MediaType = 'tv' | 'movie' | 'unknown';

/**
 * 后端 `_card_payload` 只产出 tv / movie / unknown。
 * 其它取值属于契约破坏，直接判为无效，避免未知值进入展示逻辑。
 */
const parseMediaType: Reader<MediaType> = (value) => {
  if (value === 'tv' || value === 'movie' || value === 'unknown') {
    return valid(value);
  }
  return invalid('期望 tv / movie / unknown');
};

/** 详情子结构当前只验证"是数组"，不伪造未验证的元素形状。 */
const parseUnknownArray: Reader<readonly unknown[]> = (value) =>
  Array.isArray(value) ? valid(value) : invalid('期望数组');

export interface WatchStatus {
  readonly work_id: string;
  readonly status: string;
  readonly note: string;
  readonly favorite: boolean;
  readonly updated_at: string | null;
}

export const parseWatchStatus: Reader<WatchStatus> = objectWith<WatchStatus>({
  work_id: field(string()),
  status: field(string(), true),
  note: field(string(), true),
  favorite: field(boolean(), true),
  updated_at: field(nullable(string()), true),
});

/** 已发布 artwork 的角色 → 尺寸 → URL。URL 只指向本地派生资源。 */
export type ArtworkVariants = Record<string, Record<string, string>>;

export const parseArtworkVariants: Reader<ArtworkVariants> = (value) => {
  if (!isRecord(value)) {
    return invalid('期望对象');
  }
  const result: ArtworkVariants = {};
  for (const [role, variants] of Object.entries(value)) {
    if (!isRecord(variants)) {
      return invalid(`artwork.${role} 期望对象`);
    }
    const mapped: Record<string, string> = {};
    for (const [width, url] of Object.entries(variants)) {
      if (typeof url !== 'string') {
        return invalid(`artwork.${role}.${width} 期望字符串`);
      }
      mapped[width] = url;
    }
    result[role] = mapped;
  }
  return valid(result);
};

export interface WorkCard {
  readonly work_id: string;
  readonly title: string;
  readonly original_title: string;
  readonly year: number | null;
  readonly title_provenance: string;
  readonly rating: number;
  readonly plot: string;
  readonly genres: readonly string[];
  readonly studios: readonly string[];
  readonly media_type: MediaType;
  readonly show_type: string;
  readonly card_type: string;
  readonly source: string;
  readonly sources: readonly string[];
  readonly episode_count: number;
  readonly asset_count: number;
  readonly season_count: number;
  readonly special_season_count: number;
  readonly metadata_state: string;
  /** 后端发布门槛保证：卡片只读取已发布的本地图片 URL。 */
  readonly poster_path: string;
  readonly fanart_path: string;
  readonly clearlogo_path: string;
  readonly content_scope: string;
  readonly watch_status: WatchStatus;
  readonly artwork: ArtworkVariants;
}

const WORK_CARD_SCHEMA = {
  work_id: field(string()),
  title: field(string()),
  original_title: field(string(), true),
  year: field(nullable(number()), true),
  title_provenance: field(string(), true),
  rating: field(number(), true),
  plot: field(string(), true),
  genres: field(arrayOf(string()), true),
  studios: field(arrayOf(string()), true),
  media_type: field(parseMediaType, true),
  show_type: field(string(), true),
  card_type: field(string(), true),
  source: field(string(), true),
  sources: field(arrayOf(string()), true),
  episode_count: field(number(), true),
  asset_count: field(number(), true),
  season_count: field(number(), true),
  special_season_count: field(number(), true),
  metadata_state: field(string(), true),
  poster_path: field(string(), true),
  fanart_path: field(string(), true),
  clearlogo_path: field(string(), true),
  content_scope: field(string(), true),
  watch_status: field(parseWatchStatus, true),
  artwork: field(parseArtworkVariants, true),
} as const;

export const parseWorkCard: Reader<WorkCard> = objectWith<WorkCard>(WORK_CARD_SCHEMA);

export interface Collection {
  readonly collection_id: string;
  readonly name: string;
  readonly work_ids: readonly string[];
}

export const parseCollection: Reader<Collection> = objectWith<Collection>({
  collection_id: field(string()),
  name: field(string(), true),
  work_ids: field(arrayOf(string()), true),
});

export interface LibrarySummary {
  readonly work_count: number;
  readonly episode_count: number;
}

export interface LibrarySnapshot {
  readonly change_sequence: number;
  readonly works: readonly WorkCard[];
  readonly collections: readonly Collection[];
  readonly summary: LibrarySummary;
  readonly generation_id: string;
  readonly updating: boolean;
  readonly background_active: boolean;
  readonly digest: string;
}

export const parseLibrarySnapshot: Reader<LibrarySnapshot> = objectWith<LibrarySnapshot>({
  change_sequence: field(number()),
  works: field(arrayOf(parseWorkCard)),
  collections: field(arrayOf(parseCollection), true),
  summary: field(
    objectWith<LibrarySummary>({
      work_count: field(number()),
      episode_count: field(number()),
    }),
  ),
  generation_id: field(string(), true),
  updating: field(boolean(), true),
  background_active: field(boolean(), true),
  digest: field(string(), true),
});

export interface WorkDetail extends WorkCard {
  readonly seasons: readonly unknown[];
  readonly episodes: readonly unknown[];
  readonly cast: readonly unknown[];
  readonly related_works: readonly unknown[];
}

/**
 * 详情额外字段当前只校验“是数组”。它们的完整形状在接入详情业务时
 * 再按真实响应补齐，这里不伪造未验证的子结构。
 */
export const parseWorkDetail: Reader<WorkDetail> = objectWith<WorkDetail>({
  ...WORK_CARD_SCHEMA,
  seasons: field(parseUnknownArray, true),
  episodes: field(parseUnknownArray, true),
  cast: field(parseUnknownArray, true),
  related_works: field(parseUnknownArray, true),
});

/* ------------------------------------------------------------------ */
/* /api/library/changes                                                */
/* ------------------------------------------------------------------ */

export interface LibraryChange {
  readonly sequence: number;
  readonly work_id: string;
  /** 取值来自 `progression/changes.record_change`：work_upsert / work_remove / artwork / watch / reset。 */
  readonly kind: LibraryChangeKind;
}

export type LibraryChangeKind =
  | 'work_upsert'
  | 'work_remove'
  | 'artwork'
  | 'watch'
  | 'reset'
  | 'unknown';

export interface LibraryChanges {
  /** 只推进到实际返回的末项；失败时不得用它覆盖有效游标。 */
  readonly next_sequence: number;
  readonly has_more: boolean;
  readonly reset_required: boolean;
  readonly changes: readonly LibraryChange[];
  readonly generation_id: string;
  readonly updating: boolean;
  readonly background_active: boolean;
}

const parseChange: Reader<LibraryChange> = objectWith<LibraryChange>({
  sequence: field(number()),
  work_id: field(string(), true),
  kind: field((value) => {
    const result = string()(value);
    if (!result.ok) {
      return result;
    }
    const known: readonly string[] = ['work_upsert', 'work_remove', 'artwork', 'watch', 'reset'];
    return valid(known.includes(result.value) ? (result.value as LibraryChangeKind) : 'unknown');
  }, true),
});

export const parseLibraryChanges: Reader<LibraryChanges> = objectWith<LibraryChanges>({
  next_sequence: field(number(), true),
  has_more: field(boolean(), true),
  reset_required: field(boolean(), true),
  changes: field(arrayOf(parseChange), true),
  generation_id: field(string(), true),
  updating: field(boolean(), true),
  background_active: field(boolean(), true),
});

/* ------------------------------------------------------------------ */
/* /api/tasks                                                          */
/* ------------------------------------------------------------------ */

export interface TaskResult {
  readonly revision_id: string;
  readonly work_id: string;
}

export interface TaskRecord {
  readonly task_id: string;
  readonly task_type: string;
  readonly source: string;
  readonly status: string;
  /** 后端只提供 0/1，不是连续百分比；前端不得据此拟合进度。 */
  readonly progress: number;
  readonly message: string;
  readonly created_at: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly error: string;
  readonly cancel_requested: boolean;
  readonly result: TaskResult | null;
}

export const parseTask: Reader<TaskRecord> = objectWith<TaskRecord>({
  task_id: field(string()),
  task_type: field(string(), true),
  source: field(string(), true),
  status: field(string()),
  progress: field(number(), true),
  message: field(string(), true),
  created_at: field(string(), true),
  started_at: field(string(), true),
  finished_at: field(string(), true),
  error: field(string(), true),
  cancel_requested: field(boolean(), true),
  result: field(
    nullable(
      objectWith<TaskResult>({
        revision_id: field(string(), true),
        work_id: field(string(), true),
      }),
    ),
    true,
  ),
});

export interface TaskList {
  readonly tasks: readonly TaskRecord[];
}

export const parseTaskList: Reader<TaskList> = objectWith<TaskList>({
  tasks: field(arrayOf(parseTask)),
});

/* ------------------------------------------------------------------ */
/* /api/playback/status                                                */
/* ------------------------------------------------------------------ */

/**
 * 真实响应证据：`tests/desktop/fixtures/playback-status.json`（隔离空库）。
 * 形状为 `{status, session}`；`session` 的内部字段只在有活动会话时可观测。
 *
 * 契约缺口（如实登记，不猜测）：本轮没有取得带活动会话的真实 `session` 样本，
 * 因此这里只声明它为不透明对象，未验证的字段一律不进入 UI 类型。
 * 需要真实媒体与 mpv 才能补齐，属于 P03 的验证项。
 */
export interface PlaybackStatus {
  readonly status: string;
  readonly session: Readonly<Record<string, unknown>> | null;
}

export const parsePlaybackStatus: Reader<PlaybackStatus> = objectWith<PlaybackStatus>({
  status: field(string()),
  session: field(nullable((value) => (isRecord(value) ? valid(value) : invalid('期望对象')))),
});

/* ------------------------------------------------------------------ */
/* /api/config                                                         */
/* ------------------------------------------------------------------ */

export type PublicConfig = Readonly<Record<string, unknown>>;

/** `/api/config` 是脱敏后的公开配置；这里只验证形状，不声明业务字段。 */
export const parsePublicConfig: Reader<PublicConfig> = (value) =>
  isRecord(value) ? valid(value) : invalid('期望对象');

/* ------------------------------------------------------------------ */
/* 通用错误体                                                          */
/* ------------------------------------------------------------------ */

export interface BackendErrorBody {
  readonly detail: string;
}

export const parseErrorBody: Reader<BackendErrorBody> = objectWith<BackendErrorBody>({
  detail: field(string(), true),
});

export type { Validation };
