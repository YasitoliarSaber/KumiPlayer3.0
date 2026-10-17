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

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'cancelling';

export interface TaskEntry {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly status: TaskStatus;
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
    readonly username: string;
    readonly nickname: string;
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
}

/** 用户手动覆盖：标题、图片，以及线上候选与 Bangumi 绑定。 */
export interface WorkOverride {
  readonly manualTitle?: string;
  readonly manualArtwork?: ArtworkRef & { readonly role: 'poster' | 'fanart' };
  readonly metadataCandidateId?: string;
  readonly metadataProvenance?: 'auto' | 'manual';
  readonly bangumi?: BangumiBinding;
}

/** 演示/真实实现共用的业务服务面。 */
export interface MediaService {
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
  setManualArtwork(workId: string, role: 'poster' | 'fanart', artwork: ArtworkRef): Promise<WorkOverride>;
  resetManualArtwork(workId: string): Promise<WorkOverride>;
  /** N13：Bangumi 只做同步，不参与本地身份。 */
  bangumiSearch(query: string): Promise<readonly BangumiSubject[]>;
  bangumiBind(workId: string, subjectId: string): Promise<WorkOverride>;
  bangumiUnbind(workId: string): Promise<WorkOverride>;
  bangumiSync(workId: string): Promise<TaskEntry>;
  resetDemoData(): Promise<void>;

  /* ---------------- 可选能力：只有真实后端实现，界面按能力存在与否决定是否可操作 ---------------- */

  /** 后端轻量搜索索引：标题 / 原名 / 别名 / 标签 / 制作公司，一次有界查询。 */
  searchLibrary?(query: string, limit?: number): Promise<readonly LibrarySearchHit[]>;
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
  readonly canCancel: boolean;
  readonly progress: number | null;
}

export interface SourceScanRequest {
  readonly source?: 'local' | 'tree' | 'openlist' | 'hybrid';
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
