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
    /** fluent / mica 为浅色系，cinema 为深色系；system 表示跟随系统。 */
    readonly theme: 'fluent' | 'cinema' | 'mica' | 'system';
    readonly motion: 'standard' | 'expressive' | 'reduced';
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
    readonly anilistEnabled: boolean;
    readonly imageStorageMode: string;
  };
  readonly player: {
    readonly mode: 'internal' | 'external';
    readonly externalPath: string;
    readonly autoPlayNext: boolean;
    readonly anime4kMode: string;
    readonly anime4kQuality: string;
  };
  readonly bangumi: {
    readonly configured: boolean;
    readonly username: string;
    readonly nickname: string;
    readonly syncEnabled: boolean;
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
}
