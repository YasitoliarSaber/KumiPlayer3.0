/**
 * Renderer 侧业务服务契约（用于替换真实后端的明确接口）。
 *
 * 本轮由 `mock/service.ts` 提供实现；后续接入真实后端时，
 * 由同一接口的网关实现替换，页面与组件不需要改写。
 * 这里只描述 READ 视图模型与合法命令，不重新实现识别、合卡或播放权威。
 */

export type SourceId = 'local' | 'pan115' | 'baidu' | 'quark' | 'openlist' | 'hybrid';
export type MediaType = 'tv' | 'movie';
export type ShowType = 'anime_series' | 'anime_movie' | 'live_series' | 'live_movie';
export type WatchStatus = '' | 'watching' | 'watched' | 'on_hold' | 'dropped';
export type LibraryView = 'seasonal' | 'anime_series' | 'anime_movie' | 'live_series' | 'live_movie';
export type SortId =
  | 'title'
  | 'titleDesc'
  | 'year'
  | 'yearAsc'
  | 'rating'
  | 'ratingAsc'
  | 'episodesDesc'
  | 'episodesAsc'
  | 'recent';

export interface ArtworkRef {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

export interface ArtworkSet {
  readonly poster: ArtworkRef | null;
  readonly fanart: ArtworkRef | null;
  readonly clearlogo: ArtworkRef | null;
  readonly episodeThumbs: readonly ArtworkRef[];
}

export interface WatchState {
  readonly status: WatchStatus;
  readonly favorite: boolean;
  readonly note: string;
}

export interface ProgressSnapshot {
  readonly episodeId: string;
  readonly episodeCode: string;
  readonly episodeTitle: string;
  readonly position: number;
  readonly duration: number;
  readonly completed: boolean;
  readonly updatedAt: string;
}

export interface AssetEntry {
  readonly id: string;
  readonly label: string;
  readonly resolution: string;
  readonly codec: string;
  readonly sizeLabel: string;
  readonly source: SourceId;
}

export interface EpisodeEntry {
  readonly id: string;
  readonly number: number;
  readonly code: string;
  readonly title: string;
  readonly thumb: ArtworkRef | null;
  readonly durationSec: number;
  readonly position: number;
  readonly watched: boolean;
  readonly assets: readonly AssetEntry[];
}

export interface SeasonEntry {
  readonly id: string;
  readonly number: number;
  readonly label: string;
  readonly episodes: readonly EpisodeEntry[];
}

export interface CastEntry {
  readonly name: string;
  readonly role: string;
  readonly profile: ArtworkRef | null;
}

export interface WorkSummary {
  readonly id: string;
  readonly title: string;
  readonly originalTitle: string;
  readonly year: number;
  readonly rating: number;
  readonly plot: string;
  readonly genres: readonly string[];
  readonly studios: readonly string[];
  readonly tags: readonly string[];
  readonly mediaType: MediaType;
  readonly showType: ShowType;
  readonly source: SourceId;
  readonly sources: readonly SourceId[];
  readonly seasonCount: number;
  readonly episodeCount: number;
  readonly assetCount: number;
  readonly updatedAt: string;
  readonly artwork: ArtworkSet;
  readonly watch: WatchState;
  readonly progress: ProgressSnapshot | null;
}

export interface WorkDetail extends WorkSummary {
  readonly seasons: readonly SeasonEntry[];
  readonly cast: readonly CastEntry[];
  readonly related: readonly WorkSummary[];
  readonly metadata: {
    readonly provider: string;
    readonly providerId: string;
    readonly state: string;
    readonly updatedAt: string;
  };
  readonly location: string;
  readonly collections: readonly string[];
}

/**
 * 任务状态：`pending` 是后端等待执行的**未开始**状态（`backend/app/api/tasks_v4.py:21`），
 * 不是终态；`unknown` 表示后端返回了本前端尚未登记的状态，界面必须如实展示，
 * 不得当成 succeeded，也不得静默丢弃。
 */
export type TaskStatus =
  | 'pending'
  /** durable scan 达到请求预算后的可继续状态（`backend/app/media_v4/sources/durable_scan.py:385`）。 */
  | 'paused'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'cancelling'
  | 'unknown';

export interface TaskEntry {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly status: TaskStatus;
  /** 后端原始状态字符串；枚举外的值时界面用它如实展示，不猜测语义。 */
  readonly rawStatus?: string;
  /** 后端只提供 0/1，不代表连续百分比。 */
  readonly progress: 0 | 1;
  readonly message: string;
  readonly createdAt: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly error: string;
  readonly scope: string;
  readonly cancellable: boolean;
}

export type SourceKind = 'local' | 'pan115' | 'baidu' | 'quark' | 'openlist' | 'hybrid';
export type SourceStatus =
  | 'idle'
  | 'scanning'
  | 'review'
  | 'executing'
  | 'needs_attention'
  | 'failed'
  | 'cancelled';

export interface SourceCard {
  readonly id: string;
  readonly name: string;
  readonly kind: SourceKind;
  readonly providerLabel: string;
  readonly location: string;
  readonly contentScope: 'library' | 'ongoing';
  readonly workCount: number;
  readonly workCountKnown?: boolean;
  readonly hasConfirmedBaseline?: boolean;
  /** 后端保存的原始扫描定位符；展示用 location 可能经过压缩，不能用于重扫。 */
  readonly scanPath?: string;
  readonly connectionId?: string;
  readonly lastScanAt: string;
  readonly status: SourceStatus;
  readonly statusLabel: string;
  readonly phase: 'scan' | 'review' | 'execute' | 'maintenance';
  readonly message: string;
  readonly activeTaskId: string | null;
  readonly canResume: boolean;
}

export interface ReviewIssue {
  readonly id: string;
  readonly severity: 'blocking' | 'notice';
  readonly title: string;
  readonly detail: string;
  readonly candidates: readonly { readonly id: string; readonly label: string }[];
}

export interface LibrarySnapshot {
  readonly works: readonly WorkSummary[];
  readonly sources: readonly SourceCard[];
  readonly ongoingCategoryName: string;
}

export interface SettingsSnapshot {
  readonly application: {
    readonly minimizeToTray: boolean;
    readonly closeToTray: boolean;
    readonly connectionMonitor: boolean;
    /** 首次引导：完成与"稍后设置"分开记录，未完成不等于已完成。 */
    readonly setupCompleted: boolean;
    readonly setupDeferred: boolean;
  };
  readonly appearance: {
    /** 只保留纯白（mica）与深色（cinema）；system 表示跟随系统（浅色落到纯白）。 */
    readonly theme: 'mica' | 'cinema' | 'system';
    /** 材质独立于主题：纯色 / 云母 / 亚克力。 */
    readonly material: 'solid' | 'mica' | 'acrylic' | 'liquid';
    /** 仅本机界面偏好，不写入 Python 配置。 */
    readonly font?: 'system' | 'modern' | 'wenkai';
    readonly motion: 'full' | 'reduced';
    readonly posterSize: number;
    readonly cardImageMode: 'poster' | 'fanart';
  };
  readonly sources: {
    readonly localRoots: readonly { readonly id: string; readonly path: string; readonly name: string }[];
    readonly ongoingOnStartup: boolean;
    readonly ongoingIntervalMinutes: number;
  };
  readonly openlist: {
    readonly connections: readonly {
      readonly id: string;
      readonly name: string;
      readonly serverUrl: string;
      readonly remoteRoot: string;
      readonly mountRoot: string;
      readonly configured: boolean;
    }[];
    readonly routes: readonly { readonly id: string; readonly label: string; readonly remote: string; readonly local: string }[];
  };
  readonly scrape: {
    readonly tmdbLanguage: string;
    readonly tmdbConfigured: boolean;
    /** Bangumi 名称辅助开关：只影响别名检索，不参与作品身份。 */
    readonly bangumiAliasEnabled: boolean;
    readonly anilistEnabled: boolean;
    readonly imageStorageMode: string;
  };
  readonly player: {
    readonly mode: 'internal' | 'external';
    readonly externalPath: string;
    readonly autoPlayNext: boolean;
    readonly anime4kMode: string;
    readonly anime4kQuality: string;
    /** 看完判定阈值百分比（50–100）；由后端统一判定，前端不另算。 */
    readonly completedThresholdPercent: number;
  };
  readonly bangumi: {
    readonly configured: boolean;
    readonly syncEnabled: boolean;
  };
  /** 备份偏好：每日自动备份默认关闭，保留最近 7 份（轮换由后端执行）。 */
  readonly backup: {
    readonly autoDailyEnabled: boolean;
    readonly autoDailyTime: string;
  };
}

export type SettingsSection = keyof SettingsSnapshot;

export interface PlaybackSession {
  readonly workId: string;
  readonly workTitle: string;
  readonly episodeId: string;
  readonly episodeCode: string;
  readonly episodeTitle: string;
  readonly assetId: string;
  readonly position: number;
  readonly duration: number;
  readonly paused: boolean;
}

/** 演示用刮削候选：带明确的本地作品与线上身份，不参与任何真实匹配。 */
export interface MetadataCandidate {
  readonly id: string;
  readonly title: string;
  readonly year: number;
  readonly mediaType: MediaType;
  readonly provider: string;
  readonly providerId: string;
  /** 0..1 的演示置信度，只用于展示排序。 */
  readonly confidence: number;
  /** 演示失败候选：确认会失败并保留原值。 */
  readonly failing?: boolean;
}

export interface BangumiSubject {
  readonly id: string;
  readonly title: string;
  readonly year: number;
  readonly episodes: number;
}

export interface BangumiBinding {
  readonly subjectId: string;
  readonly title: string;
  readonly status: 'matched' | 'failed';
  readonly lastSyncAt: string;
  readonly syncedEpisodes: number;
  readonly error?: string;
  /**
   * 真实后端在远端不可用时仍返回 200 并保存"空剧集映射"
   * （`backend/app/api/bangumi.py:542-545`）：条目已保存，但剧集映射待同步。
   * 这不是失败，界面必须如实区分，不能宣布"已完全同步"。
   */
  readonly episodeMappingPending?: boolean;
}

/**
 * Bangumi 账号会话（`GET /api/integrations/bangumi/session` 的视图模型）。
 * 账号显示名只来自 `user.nickname` / `user.username`：
 * `GET /api/config` 从不返回 `bangumi_username` / `bangumi_nickname`。
 */
export interface BangumiAccountSession {
  /** 凭据三态：`found` 已保存 / `unavailable` 本机凭据存储暂不可读 / `not_found` 未配置。 */
  readonly credentialState: 'found' | 'unavailable' | 'not_found';
  /** `unknown` / `valid` / `reauth_required`（`backend/app/api/bangumi.py:271-273`）。 */
  readonly authStatus: string;
  /** `unknown` / `online` / `offline` / `rate_limited` / `forbidden` / `server_error`。 */
  readonly connectivity: string;
  /** `signed_out` / `unavailable` / `available` / `connected`。 */
  readonly status: string;
  readonly nickname: string;
  readonly username: string;
  readonly avatarUrl: string;
  readonly lastVerifiedAt: string;
  readonly lastErrorCode: string;
  readonly lastErrorMessage: string;
}

/** 作品当前的 Bangumi 匹配身份（`GET|POST /api/integrations/bangumi/matches/{work_id}`）。 */
export interface BangumiMatchState {
  readonly subjectId: string;
  readonly title: string;
  readonly seasonNumber: number | null;
  /** 已建立映射的本地剧集数；`0` 表示条目已保存但剧集映射待同步。 */
  readonly mappedEpisodeCount: number;
  readonly updatedAt: string;
}

/** `POST /api/integrations/bangumi/progress/{work_id}/sync` 的双向同步摘要。 */
export interface BangumiSyncResult {
  readonly status: string;
  readonly subjectId: string;
  readonly remoteDoneBefore: number;
  readonly localDoneBefore: number;
  readonly pulled: number;
  readonly pushed: number;
}

/** Bangumi 收藏状态；与后端 `SUBJECT_COLLECTION_*` 数值一一对应（`type` 1..5）。 */
export type BangumiCollectionState = 'wish' | 'collect' | 'doing' | 'on_hold' | 'dropped';

/** 用户手动覆盖：标题、图片，以及线上候选与 Bangumi 绑定。 */
export interface WorkOverride {
  readonly manualTitle?: string;
  readonly manualArtwork?: ArtworkRef & { readonly role: 'poster' | 'fanart' | 'clearlogo' };
  readonly metadataCandidateId?: string;
  readonly metadataProvenance?: 'auto' | 'manual';
  readonly bangumi?: BangumiBinding;
}

/** 演示/真实实现共用的业务服务面。 */
export interface MediaService {
  /**
   * 实现来源标识：真实后端 = `real`，本机演示存储 = `demo`。
   * 页面只用它选择"读哪份本机偏好/引导状态"，不据此改变业务语义，
   * 真实模式也不会因为失败而变成演示模式。
   */
  readonly serviceMode: 'real' | 'demo';
  listLibrary(signal?: AbortSignal): Promise<LibrarySnapshot>;
  getWorkDetail(workId: string, signal?: AbortSignal): Promise<WorkDetail>;
  listSources(signal?: AbortSignal): Promise<readonly SourceCard[]>;
  getReviewIssues(sourceId: string): Promise<readonly ReviewIssue[]>;
  startScan(sourceId: string): Promise<TaskEntry>;
  confirmRevision(sourceId: string, decisions: Readonly<Record<string, string>>): Promise<TaskEntry>;
  listTasks(signal?: AbortSignal): Promise<readonly TaskEntry[]>;
  cancelTask(taskId: string): Promise<TaskEntry>;
  retryTask(taskId: string): Promise<TaskEntry>;
  setFavorite(workId: string, favorite: boolean): Promise<WorkSummary>;
  setWatchStatus(workId: string, status: WatchStatus): Promise<WorkSummary>;
  saveProgress(workId: string, episodeId: string, position: number, duration: number): Promise<void>;
  getSettings(): Promise<SettingsSnapshot>;
  updateSettings(section: SettingsSection, patch: Record<string, unknown>): Promise<SettingsSnapshot>;
  play(workId: string, episodeId: string, assetId: string): Promise<PlaybackSession>;
  stopPlayback(): Promise<PlaybackSession | null>;
  getPlayback(): Promise<PlaybackSession | null>;
  /** N12：演示候选检索与人工确认（不访问在线服务）。 */
  metadataCandidates(workId: string, query: string): Promise<readonly MetadataCandidate[]>;
  confirmCandidate(workId: string, candidateId: string): Promise<WorkOverride>;
  setManualTitle(workId: string, title: string): Promise<WorkOverride>;
  resetManualTitle(workId: string): Promise<WorkOverride>;
  setManualArtwork(
    workId: string,
    role: 'poster' | 'fanart' | 'clearlogo',
    artwork: ArtworkRef,
  ): Promise<WorkOverride>;
  /** 恢复自动图片必须按角色恢复：后端 `DELETE /works/{id}/artwork/{kind}` 逐个角色处理。 */
  resetManualArtwork(
    workId: string,
    role?: 'poster' | 'fanart' | 'clearlogo',
  ): Promise<WorkOverride>;
  /** N13：Bangumi 只做同步，不参与本地身份。 */
  bangumiSearch(query: string): Promise<readonly BangumiSubject[]>;
  bangumiBind(workId: string, subjectId: string): Promise<void>;
  bangumiUnbind(workId: string): Promise<void>;
  bangumiSync(workId: string): Promise<BangumiSyncResult>;
  resetDemoData(): Promise<void>;

  /* ---------------- 可选能力：只有真实后端实现，界面按能力存在与否决定是否可操作 ---------------- */

  /**
   * 首次引导：完成与"稍后设置"是两条独立通道——
   * 完成后端会校验播放器与至少一个可访问来源，稍后设置只记录推迟。
   * 失败必须抛出可读错误（界面保留输入并显示原因），不得当作已完成。
   */
  completeSetup?(input: SetupCompletionInput): Promise<SettingsSnapshot>;
  deferSetup?(): Promise<SettingsSnapshot>;
  /** TMDB 令牌经后端验证后才写入；验证失败不保存，也不落本地存储。 */
  saveTmdbCredential?(token: string): Promise<SettingsSnapshot>;
  /** 后端轻量搜索索引：标题 / 原名 / 别名 / 标签 / 制作公司，一次有界查询。 */
  searchLibrary?(query: string, limit?: number): Promise<LibrarySearchResult>;
  listScanSchedules?(): Promise<readonly SourceScanSchedule[]>;
  setScanSchedule?(
    rootId: string,
    input: { readonly enabled: boolean; readonly intervalMinutes: number },
  ): Promise<SourceScanSchedule>;
  startSourceScan?(request: SourceScanRequest): Promise<ScanProgress>;
  getSourceScan?(scanId: string): Promise<ScanProgress>;
  cancelSourceScan?(scanId: string): Promise<ScanProgress>;
  previewImport?(scanId: string): Promise<ImportPreviewSummary>;
  confirmImport?(revisionId: string): Promise<ImportConfirmResult>;
  cancelImport?(revisionId: string): Promise<{ readonly cancelled: number; readonly running: number }>;
  listBackups?(): Promise<BackupList>;
  exportBackup?(): Promise<BackupFileEntry>;
  downloadBackup?(fileId: string): Promise<{ readonly blob: Blob; readonly filename: string }>;
  previewRestore?(file: File): Promise<RestorePreview>;
  confirmRestore?(previewId: string, digest: string): Promise<RestoreApplied>;
  previewArtworkCache?(retentionDays: number): Promise<ArtworkCachePreview>;
  confirmArtworkCache?(
    previewId: string,
    digest: string,
  ): Promise<{ readonly removedFiles: number; readonly freedBytes: number }>;
  /** 连接测试只返回可达性与受控摘要；不返回、不记录任何凭据。 */
  testOpenListConnection?(input: {
    readonly connectionId?: string;
    readonly serverUrl?: string;
    readonly remoteRoot?: string;
    readonly username?: string;
    readonly password?: string;
  }): Promise<{ readonly ok: boolean; readonly code: string; readonly message: string; readonly phase: string }>;

  /* ---------------- 作品详情真实操作（后端既有端点，只是此前未接） ---------------- */

  /** 手动重新刮削：为指定作品重排队同一 V4 job 链（`POST /api/v4/works/{id}/scrape`）。 */
  scrapeWork?(workId: string): Promise<WorkScrapeResult>;
  /** 只读解析该作品已确认 Asset 的所在目录（`GET /api/v4/works/{id}/folder`），不打开窗口。 */
  getWorkFolder?(workId: string): Promise<WorkFolderInfo>;
  /**
   * 由本机后端按身份打开所在位置（`POST /api/system/open-folder`）。
   * 只提交身份 ID，不提交路径；打开动作由后端宿主进程在真实文件系统上执行。
   */
  openWorkFolder?(input: WorkFolderOpenInput): Promise<WorkFolderOpenResult>;
  /** 删除前服务端影响预览（只读，不删任何内容）。 */
  previewWorkDelete?(workId: string): Promise<WorkDeletePreview>;
  /** 按预览身份确认删除：只退役受控库记录与受管生成物，绝不删除真实影片。 */
  confirmWorkDelete?(workId: string, input: WorkDeleteConfirmInput): Promise<WorkDeleteResult>;

  /* ---------------- Bangumi 账号与同步（后端既有端点，只是此前未接） ---------------- */

  /** 本地会话恢复（0 个远程请求）：凭据三态 + 上次验证快照。 */
  bangumiSession?(): Promise<BangumiAccountSession>;
  /** 显式远程验证；远端失败仍返回 200，必须读 `authStatus` / `connectivity`。 */
  bangumiVerify?(): Promise<BangumiAccountSession>;
  /** 提交访问令牌：后端先验证再落本机凭据存储，前端不保存任何令牌副本。 */
  bangumiSignIn?(accessToken: string): Promise<BangumiAccountSession>;
  /** 退出登录：后端清除令牌与本地账户快照。 */
  bangumiSignOut?(): Promise<void>;
  /** 作品当前匹配身份；未匹配返回 null（后端用 404 表达）。 */
  bangumiMatch?(workId: string): Promise<BangumiMatchState | null>;
  /** 同步 Bangumi 收藏状态（`PATCH /api/integrations/bangumi/collections/{id}`）。 */
  bangumiSetCollection?(workId: string, state: BangumiCollectionState): Promise<void>;
}

/** 作品详情真实操作的结果视图模型。 */
export interface WorkScrapeResult {
  readonly jobId: string;
  readonly status: string;
}

export interface WorkFolderInfo {
  readonly folder: string;
  readonly exists: boolean;
}

export interface WorkFolderOpenInput {
  readonly workId: string;
  readonly episodeId?: string;
  readonly assetId?: string;
}

export interface WorkFolderOpenResult {
  readonly opened: boolean;
  readonly exists: boolean;
  readonly folderPath: string;
}

/**
 * 删除预览。后端还会回传 `artifact_paths` 等绝对路径，但渲染进程只需要
 * 计数与类型（避免把本机绝对路径带进界面层）。
 */
export interface WorkDeletePreview {
  readonly previewId: string;
  readonly digest: string;
  readonly revisionId: string;
  readonly artifactCount: number;
  readonly playbackCount: number;
  readonly trackingCount: number;
  readonly blocked: boolean;
  readonly blockedJobCount: number;
  readonly blockedJobTypes: readonly string[];
}

export interface WorkDeleteConfirmInput {
  readonly previewId: string;
  readonly digest: string;
}

export interface WorkDeleteResult {
  readonly status: string;
  readonly projectionStatus: string;
  readonly removedArtifacts: number;
  readonly blockedArtifacts: number;
  readonly failedArtifacts: number;
}

/** 后端 `/api/library/search` 的单条命中；不含图片，展示端与已加载索引按 work_id 关联。 */
export interface LibrarySearchHit {
  readonly workId: string;
  readonly title: string;
  readonly originalTitle: string;
  readonly year: number | null;
  readonly mediaType: string;
  readonly matchedFields: readonly string[];
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly studios: readonly string[];
}

/**
 * `/api/library/search` 的完整结果。
 * `truncated` 由后端给出（命中数超过 limit 时为 true）：界面必须如实提示
 * "结果过多、只显示前 N 条"，不能把截断当成"没有更多命中"。
 */
export interface LibrarySearchResult {
  readonly hits: readonly LibrarySearchHit[];
  readonly truncated: boolean;
}

/** durable SourceScan 的读状态；不提供连续百分比时不伪造进度。 */
export interface ScanProgress {
  readonly scanId: string;
  readonly rootId: string;
  readonly status: string;
  readonly stage: string;
  readonly stageLabel: string;
  readonly processedCount: number;
  readonly totalCount: number;
  readonly discoveredCount: number;
  readonly currentDirectory: string;
  readonly error: string;
  readonly resumable: boolean;
  readonly cancelRequested: boolean;
  /** `GET /api/v4/sources/scans/{id}` 的 `interrupted`：上次执行者心跳失联。 */
  readonly interrupted: boolean;
  readonly evidenceCount: number;
  readonly parsedCount: number;
  readonly directoriesCompleted: number;
  readonly directoriesPending: number;
  readonly heartbeatAt: string;
  /** 派生字段（后端不返回 `can_cancel`）：由状态推断，不当作后端事实展示。 */
  readonly canCancel: boolean;
  readonly progress: number | null;
  /**
   * 路径多解：只有**启动扫描**的响应可能给出
   * `status='mapping_required'` + 空 `scan_id` + `path_validation.choices`
   * （`backend/app/api/media_v4.py:541-549`）。它不落库，GET 永远不会返回。
   */
  readonly mapping: ScanPathValidation | null;
}

/** `path_validation.choices[]` 的元素（后端只外发这 6 个字段）。 */
export interface ScanMappingChoice {
  readonly id: string;
  readonly root: string;
  readonly mappingScope: string;
  readonly pathSamples: readonly string[];
  readonly selectedCount: number;
  readonly skippedCount: number;
}

/** `path_validation`：路径映射校验结果；多解时必须由用户显式选择，不能静默取第一个候选。 */
export interface ScanPathValidation {
  readonly ok: boolean;
  readonly root: string;
  readonly reason: string;
  readonly state: string;
  readonly mappingMode: string;
  readonly mappingScope: string;
  readonly selectedCount: number;
  readonly skippedCount: number;
  readonly pathSamples: readonly string[];
  readonly requiresConfirmation: boolean;
  readonly choices: readonly ScanMappingChoice[];
}

export interface SourceScanRequest {
  readonly source?: 'local' | 'tree' | 'openlist' | 'hybrid';
  readonly provider?: 'pan115' | 'baidu' | 'quark';
  readonly rootPath?: string;
  readonly treeFile?: string;
  readonly contentScope?: 'library' | 'ongoing';
  readonly scanMode?: 'full' | 'incremental';
  /** 已登记来源的重扫 / 更新目标（稳定 root_id）。 */
  readonly targetRootId?: string;
  readonly revisionId?: string;
  readonly sourceDisplayName?: string;
  readonly resumeScanId?: string;
  readonly connectionId?: string;
  /** 用户在多解候选里选定的映射（`tree_mapping_choice`）；不选择就不提交。 */
  readonly treeMappingChoice?: string;
  readonly treeMappingMode?: 'auto' | 'manual';
  readonly treeMappingScope?: string;
  readonly treeVerifyPaths?: boolean;
  readonly openlistMappingChoice?: string;
}

/**
 * 首次引导「完成设置」的输入：只提交用户这次真正给出的值。
 * 未提供的字段由后端保留已保存的配置，传空字符串不会当成"清空"。
 */
export interface SetupCompletionInput {
  readonly localRoot?: string;
  readonly pan115Root?: string;
  readonly baiduRoot?: string;
  readonly directoryTreeDir?: string;
  readonly playerMode?: 'internal' | 'external';
  readonly externalMpvPath?: string;
  readonly mpvPath?: string;
}

export interface ImportPreviewSummary {
  readonly revisionId: string;
  readonly status: string;
  readonly workCount: number;
  readonly episodeCount: number;
  readonly blockingIssueCount: number;
  readonly issues: readonly ReviewIssue[];
}

export interface ImportConfirmResult {
  readonly revisionId: string;
  readonly status: string;
  readonly jobCount: number;
}

/** 来源 + 扫描 + revision + jobs + 调度的分离读数（不合并成一个百分比）。 */
export interface SourceScanSchedule {
  readonly rootId: string;
  readonly displayName: string;
  readonly provider: string;
  readonly ingestMethod: string;
  readonly sourceMode: string;
  readonly contentScope: string;
  readonly enabled: boolean;
  readonly schedule: {
    readonly enabled: boolean;
    readonly intervalMinutes: number;
    readonly lastRunAt: string;
    readonly nextRunAt: string;
  };
  readonly status: string;
  readonly reason: string;
  readonly taskId: string;
  readonly activityKind: string;
  readonly canCancel: boolean;
  readonly scan: {
    readonly scanId: string;
    readonly status: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly canResume: boolean;
    readonly canCancel: boolean;
    readonly message: string;
  };
  readonly revision: {
    readonly latestRevisionId: string;
    readonly draftRevisionId: string;
    readonly status: string;
    readonly reason: string;
  };
  readonly jobs: {
    readonly queued: number;
    readonly running: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly latestJobId: string;
  };
}

export interface BackupFileEntry {
  readonly fileId: string;
  readonly fileName: string;
  readonly kind: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly downloadUrl: string;
}

export interface BackupAutoStatus {
  readonly enabled: boolean;
  readonly time: string;
  readonly keep: number;
  readonly lastRunAt: string;
  readonly nextRunAt: string;
  readonly lastStatus: string;
  readonly lastError: string;
  readonly lastFileId: string;
}

export interface BackupList {
  readonly files: readonly BackupFileEntry[];
  readonly auto: BackupAutoStatus;
  readonly scope: { readonly includes: readonly string[]; readonly excludes: readonly string[] };
}

export interface RestorePreview {
  readonly previewId: string;
  readonly digest: string;
  readonly backup: {
    readonly createdAt: string;
    readonly appVersion: string;
    readonly schemaVersion: number;
    readonly formatVersion: number;
    readonly scope: readonly string[];
  };
  readonly config: {
    readonly changedFields: readonly string[];
    /** 备份里存在、但当前版本不恢复的字段（后端 `ignored_fields`）；只展示，不假装已恢复。 */
    readonly ignoredFields: readonly string[];
    readonly sourceChanges: readonly { readonly field: string; readonly action: string }[];
  };
  readonly watchRecords: {
    readonly progress: number;
    readonly history: number;
    readonly watchStatus: number;
    readonly overrides: number;
    readonly matched: number;
    readonly orphans: number;
  };
  readonly orphans: readonly { readonly kind: string; readonly workId: string; readonly episodeId: string }[];
  readonly credentials: { readonly included: boolean; readonly note: string };
  readonly expiresAt: string;
}

export interface RestoreApplied {
  readonly configFields: readonly string[];
  readonly watchRecords: {
    readonly progress: number;
    readonly history: number;
    readonly watchStatus: number;
    readonly overrides: number;
  };
  readonly orphans: readonly { readonly kind: string; readonly workId: string; readonly episodeId: string }[];
  readonly message: string;
}

export interface ArtworkCachePreview {
  readonly previewId: string;
  readonly digest: string;
  /** 服务端预览计划里可公开的计数与体积；字段缺失时按 0 展示，不推算。 */
  readonly removableFiles: number;
  readonly freedBytes: number;
  readonly retentionDays: number;
  readonly expiresAt: string;
}
