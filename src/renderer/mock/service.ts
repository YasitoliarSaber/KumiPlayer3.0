/**
 * 演示业务服务：`MediaService` 的本地实现。
 *
 * 全部数据来自确定性演示目录与本机演示存储，只模拟加载延迟、任务生命周期
 * 与错误场景；不连接 Python、数据库、真实来源、真实配置或 mpv，
 * 也不声称任何真实后端连接成功。
 */

import { buildMockCatalog, buildMockDetail, type MockCatalog } from './catalog';
import {
  getDemoState,
  resetDemoState,
  setPlayback,
  updateDemoState,
  upsertTask,
} from './demo-store';
import type {
  LibrarySnapshot,
  MediaService,
  PlaybackSession,
  ReviewIssue,
  SettingsSection,
  SettingsSnapshot,
  SourceCard,
  SourceId,
  TaskEntry,
  WorkDetail,
  WorkOverride,
  WorkSummary,
} from '../shared/api/service';

export class DemoServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoServiceError';
  }
}

interface MockServiceOptions {
  /** 基准加载延迟（毫秒）；测试可设为 0。 */
  readonly latencyMs?: number;
  readonly catalog?: MockCatalog;
}

type SourceDefinition = Omit<
  SourceCard,
  'workCount' | 'activeTaskId' | 'canResume' | 'status' | 'statusLabel' | 'message' | 'lastScanAt'
>;

const SOURCE_DEFINITIONS: readonly SourceDefinition[] = [
  {
    id: 'src-local-anime',
    name: '本地动画库',
    kind: 'local',
    providerLabel: '本地目录',
    location: 'D:\\Media\\Anime',
    contentScope: 'library',
    phase: 'scan',
  },
  {
    id: 'src-txt-115',
    name: '115 目录树',
    kind: 'pan115',
    providerLabel: '115 网盘',
    location: 'E:\\export\\115_tree.txt',
    contentScope: 'library',
    phase: 'scan',
  },
  {
    id: 'src-openlist',
    name: 'OpenList 增量',
    kind: 'openlist',
    providerLabel: 'OpenList',
    location: '/115/anime',
    contentScope: 'ongoing',
    phase: 'review',
  },
  {
    id: 'src-baidu',
    name: '百度目录树',
    kind: 'baidu',
    providerLabel: '百度网盘',
    location: 'E:\\export\\baidu_tree.txt',
    contentScope: 'library',
    phase: 'scan',
  },
  {
    id: 'src-hybrid',
    name: 'TXT 与 OpenList 混合',
    kind: 'hybrid',
    providerLabel: '混合来源',
    location: '/quark/movie',
    contentScope: 'library',
    phase: 'maintenance',
  },
];

const REVIEW_ISSUES: readonly ReviewIssue[] = [
  {
    id: 'issue-1',
    severity: 'blocking',
    title: '无法确定作品身份',
    detail: '目录名「未命名合集 2024」无法匹配到唯一线上作品，需要选择候选项或手动指定标题。',
    candidates: [
      { id: 'cand-1', label: '示例候选作品 A（2024）' },
      { id: 'cand-2', label: '示例候选作品 B（2023）' },
      { id: 'cand-3', label: '保留为本地作品' },
    ],
  },
  {
    id: 'issue-2',
    severity: 'blocking',
    title: '播放路径不可达',
    detail: '来源声明的位置在当前挂载中不存在，请确认挂载根或选择其他映射。',
    candidates: [
      { id: 'cand-1', label: '使用在线扫描结果' },
      { id: 'cand-2', label: '手动指定挂载根' },
    ],
  },
  {
    id: 'issue-3',
    severity: 'notice',
    title: '集号存在歧义',
    detail: '第 3 集在来源中出现两次（1080p / 2160p），演示中保留为两个版本 Asset。',
    candidates: [],
  },
];

export function createMockMediaService(options: MockServiceOptions = {}): MediaService {
  // 目录按演示库规模缓存：压力模式复用同一小批图片，只放大元数据条目。
  const catalogs = new Map<number, MockCatalog>();
  const catalogFor = (size: number): MockCatalog => {
    if (options.catalog) {
      return options.catalog;
    }
    const cached = catalogs.get(size);
    if (cached) {
      return cached;
    }
    const built = buildMockCatalog({ count: size });
    catalogs.set(size, built);
    return built;
  };
  const currentCatalog = (): MockCatalog => catalogFor(getDemoState().librarySize);
  const latency = options.latencyMs ?? 180;
  /**
   * 本服务实例创建的全部定时器。切换场景或重置演示数据时统一清理，
   * 避免反复操作后留下仍在跑的定时器。
   */
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const track = (timer: ReturnType<typeof setTimeout>) => {
    pendingTimers.add(timer);
    return timer;
  };
  const clearTimers = () => {
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
  };

  const wait = async (signal?: AbortSignal, extra = 0) => {
    // 慢操作场景：把写入路径拉长，便于人工尝试重复点击。
    const slowBonus = getDemoState().scenario === 'slow-actions' ? 900 : 0;
    const total = latency + extra + slowBonus;
    if (total > 0) {
      // 取消时立即结束等待，不再让一个已经作废的请求继续占着时限。
      await new Promise<void>((resolve, reject) => {
        const timer = track(
          setTimeout(() => {
            pendingTimers.delete(timer);
            resolve();
          }, total),
        );
        if (signal) {
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              pendingTimers.delete(timer);
              reject(new DemoServiceError('读取已取消'));
            },
            { once: true },
          );
        }
      });
    }
    if (signal?.aborted) {
      throw new DemoServiceError('读取已取消');
    }
    const scenario = getDemoState().scenario;
    if (scenario === 'error') {
      throw new DemoServiceError('演示场景：模拟本地服务不可用');
    }
    if (scenario === 'loading') {
      // 长加载场景：保持等待，直到场景被切换或调用方取消。
      await new Promise<void>((resolve, reject) => {
        const timer = setInterval(() => {
          if (getDemoState().scenario !== 'loading') {
            clearInterval(timer);
            resolve();
          }
        }, 200);
        signal?.addEventListener(
          'abort',
          () => {
            clearInterval(timer);
            reject(new DemoServiceError('读取已取消'));
          },
          { once: true },
        );
      });
    }
  };

  const schedule = (fn: () => void, delayMs: number) => {
    const timer = track(
      setTimeout(() => {
        pendingTimers.delete(timer);
        fn();
      }, delayMs),
    );
    return timer;
  };

  const applyOverrides = (work: WorkSummary): WorkSummary => {
    const state = getDemoState();
    const favorite = state.favorite[work.id];
    const status = state.watch[work.id];
    const progress = state.progress[work.id];
    const override = state.overrides[work.id] ?? {};
    const manualArtwork = override.manualArtwork;
    const artwork = manualArtwork
      ? { ...work.artwork, [manualArtwork.role]: manualArtwork }
      : work.artwork;
    return {
      ...work,
      title: override.manualTitle?.trim() || work.title,
      artwork,
      watch: {
        ...work.watch,
        ...(favorite === undefined ? {} : { favorite }),
        ...(status === undefined ? {} : { status }),
      },
      progress: progress ?? work.progress,
    };
  };

  const overrideOf = (workId: string): WorkOverride => getDemoState().overrides[workId] ?? {};

  /**
   * 场景化的展示变形：只影响"看到什么"，不改媒体事实与覆盖层。
   * 缺图 / 长标题用于检查回退与排版，无版本用于检查"不可播放"提示。
   */
  const applyScenario = (work: WorkSummary): WorkSummary => {
    const scenario = getDemoState().scenario;
    if (scenario === 'missing-artwork') {
      return {
        ...work,
        artwork: { poster: null, fanart: null, clearlogo: null, episodeThumbs: [] },
      };
    }
    if (scenario === 'long-titles') {
      return {
        ...work,
        title: `${work.title}：这是一个用于检查中文长标题排版与省略行为的超长作品名称（演示）`,
        originalTitle: `${work.originalTitle} — an intentionally very long original title used for layout checks`,
      };
    }
    return work;
  };

  const applyDetailScenario = (detail: WorkDetail): WorkDetail => {
    const scenario = getDemoState().scenario;
    if (scenario !== 'no-assets') {
      return detail;
    }
    return {
      ...detail,
      seasons: detail.seasons.map((season) => ({
        ...season,
        episodes: season.episodes.map((episode) => ({ ...episode, assets: [] })),
      })),
      assetCount: 0,
    };
  };

  const setOverride = (workId: string, patch: Partial<WorkOverride>): WorkOverride => {
    const merged: Record<string, unknown> = { ...overrideOf(workId), ...patch };
    // undefined 表示"恢复自动"，需要真正删除该字段而不是写入 undefined。
    for (const key of Object.keys(merged)) {
      if (merged[key] === undefined) {
        delete merged[key];
      }
    }
    const next = merged as WorkOverride;
    updateDemoState((current) => ({ overrides: { ...current.overrides, [workId]: next } }));
    return next;
  };

  const workById = (workId: string): WorkSummary => {
    const found = currentCatalog().byId.get(workId);
    if (!found) {
      throw new DemoServiceError('演示数据中没有这个作品');
    }
    return applyOverrides(found);
  };

  const sourceCards = (): readonly SourceCard[] => {
    const state = getDemoState();
    const works = state.scenario === 'empty' ? [] : currentCatalog().works.map(applyScenario);
    return SOURCE_DEFINITIONS.map((definition, index) => {
      const activeTask = state.tasks.find(
        (task) =>
          task.sourceId === definition.id &&
          (task.status === 'queued' || task.status === 'running' || task.status === 'cancelling'),
      );
      const override = state.sourceOverrides[definition.id] ?? {};
      const baseline: SourceCard['status'] =
        definition.phase === 'review' ? 'needs_attention' : 'idle';
      const status: SourceCard['status'] = activeTask ? 'scanning' : (override.status ?? baseline);
      const phase = override.phase ?? definition.phase;
      return {
        ...definition,
        ...override,
        phase,
        workCount: works.filter((work) => work.sources.includes(definition.kind as SourceId)).length,
        lastScanAt: isoHoursAgo(index * 7 + 2),
        status,
        statusLabel: sourceStatusLabel(status, phase),
        message:
          override.message ??
          (definition.phase === 'review'
            ? '有 2 个识别问题需要处理'
            : definition.phase === 'maintenance'
              ? '有来源需要维护'
              : index === 1
                ? '上次扫描完成，无变化'
                : ''),
        activeTaskId: activeTask?.id ?? null,
        canResume: override.canResume ?? definition.phase === 'review',
      };
    });
  };

  const transitionToRunning = (taskId: string) => {
    schedule(() => {
      const latest = getDemoState().tasks.find((entry) => entry.id === taskId);
      if (!latest || latest.status === 'cancelled') {
        return;
      }
      upsertTask({
        ...latest,
        status: 'running',
        message: '正在执行（演示）',
        startedAt: new Date().toISOString(),
      });
    }, 350);
  };

  const transitionToSucceeded = (taskId: string, delayMs: number, message: string) => {
    schedule(() => {
      const latest = getDemoState().tasks.find((entry) => entry.id === taskId);
      if (!latest || latest.status === 'cancelled') {
        return;
      }
      upsertTask({
        ...latest,
        status: 'succeeded',
        progress: 1,
        message,
        finishedAt: new Date().toISOString(),
        cancellable: false,
      });
    }, delayMs);
  };

  const transitionToFailed = (taskId: string, delayMs: number, message: string) => {
    schedule(() => {
      const latest = getDemoState().tasks.find((entry) => entry.id === taskId);
      if (!latest || latest.status === 'cancelled') {
        return;
      }
      upsertTask({
        ...latest,
        status: 'failed',
        progress: 0,
        error: message,
        message,
        finishedAt: new Date().toISOString(),
        cancellable: false,
      });
    }, delayMs);
  };

  const createTask = (input: {
    readonly type: string;
    readonly title: string;
    readonly sourceId: string;
    readonly sourceName: string;
    readonly scope: string;
    readonly durationMs: number;
    readonly resultMessage: string;
  }): TaskEntry => {
    const id = `task-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
    const task: TaskEntry = {
      id,
      type: input.type,
      title: input.title,
      sourceId: input.sourceId,
      sourceName: input.sourceName,
      status: 'queued',
      progress: 0,
      message: '等待执行',
      createdAt: new Date().toISOString(),
      startedAt: '',
      finishedAt: '',
      error: '',
      scope: input.scope,
      cancellable: true,
    };
    upsertTask(task);
    transitionToRunning(id);
    // 任务失败场景用于演示失败与重试路径；默认场景正常收敛为成功。
    if (getDemoState().scenario === 'task-failure') {
      transitionToFailed(id, input.durationMs, '演示场景：任务在执行阶段失败，可重试');
    } else {
      transitionToSucceeded(id, input.durationMs, input.resultMessage);
    }
    return task;
  };

  const service: MediaService = {
    async listLibrary(signal) {
      await wait(signal);
      const state = getDemoState();
      const snapshot: LibrarySnapshot = {
        works:
          state.scenario === 'empty'
            ? []
            : currentCatalog().works.map(applyOverrides).map(applyScenario),
        sources: sourceCards(),
        ongoingCategoryName: '新番',
      };
      return snapshot;
    },

    async getWorkDetail(workId, signal) {
      await wait(signal, 40);
      const detail: WorkDetail = applyDetailScenario(buildMockDetail(workById(workId), currentCatalog()));
      return detail;
    },

    async listSources(signal) {
      await wait(signal);
      return sourceCards();
    },

    async getReviewIssues() {
      await wait(undefined, 60);
      return REVIEW_ISSUES;
    },

    async startScan(sourceId) {
      await wait(undefined, 80);
      const source = sourceCards().find((card) => card.id === sourceId);
      return createTask({
        type: 'source_scan',
        title: '扫描来源',
        sourceId,
        sourceName: source?.name ?? '演示来源',
        scope: 'scan',
        durationMs: 2600,
        resultMessage: '扫描完成：发现 12 个新增条目（演示）',
      });
    },

    async confirmRevision(sourceId) {
      await wait(undefined, 120);
      const source = sourceCards().find((card) => card.id === sourceId);
      updateDemoState((current) => ({
        sourceOverrides: {
          ...current.sourceOverrides,
          [sourceId]: { phase: 'execute', status: 'scanning', canResume: false, message: '' },
        },
      }));
      const task = createTask({
        type: 'projection_publish',
        title: '确认修订并发布',
        sourceId,
        sourceName: source?.name ?? '演示来源',
        scope: 'revision',
        durationMs: 3200,
        resultMessage: '确认完成：已写入演示修订并发布作品（演示）',
      });
      schedule(() => {
        updateDemoState((current) => ({
          sourceOverrides: {
            ...current.sourceOverrides,
            [sourceId]: { phase: 'scan', status: 'idle', canResume: false, message: '上次导入已完成' },
          },
        }));
      }, 3400);
      return task;
    },

    async listTasks(signal) {
      await wait(signal);
      return getDemoState().tasks;
    },

    async cancelTask(taskId) {
      await wait(undefined, 40);
      const task = getDemoState().tasks.find((entry) => entry.id === taskId);
      if (!task) {
        throw new DemoServiceError('任务不存在');
      }
      const cancelling: TaskEntry = { ...task, status: 'cancelling', message: '正在终止（演示）' };
      upsertTask(cancelling);
      schedule(() => {
        const latest = getDemoState().tasks.find((entry) => entry.id === taskId);
        if (!latest) {
          return;
        }
        upsertTask({
          ...latest,
          status: 'cancelled',
          message: '已取消：取消作用于整个修订（演示）',
          finishedAt: new Date().toISOString(),
          cancellable: false,
        });
      }, 700);
      return cancelling;
    },

    async retryTask(taskId) {
      await wait(undefined, 60);
      const task = getDemoState().tasks.find((entry) => entry.id === taskId);
      if (!task) {
        throw new DemoServiceError('任务不存在');
      }
      if (task.status !== 'failed' && task.status !== 'cancelled') {
        throw new DemoServiceError('只有失败或已取消任务可以重试');
      }
      const queued: TaskEntry = {
        ...task,
        status: 'queued',
        progress: 0,
        message: '等待执行（重试）',
        error: '',
        startedAt: '',
        finishedAt: '',
        cancellable: true,
      };
      upsertTask(queued);
      transitionToRunning(taskId);
      transitionToSucceeded(taskId, 2200, '重试完成（演示）');
      return queued;
    },

    async setFavorite(workId, favorite) {
      await wait(undefined, 20);
      updateDemoState((current) => ({ favorite: { ...current.favorite, [workId]: favorite } }));
      return workById(workId);
    },

    async setWatchStatus(workId, status) {
      await wait(undefined, 20);
      updateDemoState((current) => ({ watch: { ...current.watch, [workId]: status } }));
      return workById(workId);
    },

    async saveProgress(workId, episodeId, position, duration) {
      updateDemoState((current) => ({
        progress: {
          ...current.progress,
          [workId]: {
            episodeId,
            episodeCode: episodeCodeOf(episodeId),
            episodeTitle: '演示进度',
            position,
            duration,
            completed: duration > 0 && position / duration > 0.95,
            updatedAt: new Date().toISOString(),
          },
        },
        watch: {
          ...current.watch,
          [workId]: duration > 0 && position / duration > 0.95 ? 'watched' : 'watching',
        },
      }));
    },

    async getSettings() {
      await wait(undefined, 30);
      return getDemoState().settings;
    },

    async updateSettings(section: SettingsSection, patch: Record<string, unknown>) {
      await wait(undefined, 30);
      const settings = getDemoState().settings;
      const updated = {
        ...settings,
        [section]: { ...settings[section], ...patch },
      } as SettingsSnapshot;
      updateDemoState(() => ({ settings: updated }));
      return updated;
    },

    async play(workId, episodeId, assetId) {
      await wait(undefined, 80);
      const detail = applyDetailScenario(buildMockDetail(workById(workId), currentCatalog()));
      const episodes = detail.seasons.flatMap((season) => season.episodes);
      const episode =
        episodes.find((entry) => entry.id === episodeId) ?? episodes[0];
      if (!episode) {
        throw new DemoServiceError('该作品没有可播放的剧集');
      }
      const session: PlaybackSession = {
        workId,
        workTitle: detail.title,
        episodeId: episode.id,
        episodeCode: episode.code,
        episodeTitle: episode.title,
        assetId: assetId || episode.assets[0]?.id || '',
        position: episode.position,
        duration: episode.durationSec,
        paused: false,
      };
      setPlayback(session);
      return session;
    },

    async stopPlayback() {
      const session = getDemoState().playback;
      if (session) {
        await service.saveProgress(session.workId, session.episodeId, session.position, session.duration);
      }
      setPlayback(null);
      return session;
    },

    async getPlayback() {
      await wait(undefined, 10);
      return getDemoState().playback;
    },

    async metadataCandidates(workId, query) {
      await wait(undefined, 60);
      const work = workById(workId);
      const needle = query.trim();
      // 空查询视为"没有可用候选"，用于演示需要人工介入的失败路径。
      if (needle.length === 0) {
        return [];
      }
      const pool = currentCatalog().works.filter((candidate) => candidate.id !== work.id);
      return [0, 1, 2].map((offset) => {
        const source = pool[(work.title.length + offset * 7) % pool.length] ?? work;
        return {
          id: `cand-${work.id}-${offset + 1}`,
          title: offset === 0 ? needle : `${needle}（候选 ${offset + 1}）`,
          year: source.year,
          mediaType: source.mediaType,
          provider: 'TMDB（演示）',
          providerId: `demo-${source.id}`,
          confidence: Number((0.92 - offset * 0.21).toFixed(2)),
          // 置信度过低的候选用于演示"确认失败保留原值"。
          failing: offset === 2,
        };
      });
    },

    async confirmCandidate(workId, candidateId) {
      await wait(undefined, 80);
      const candidates = await service.metadataCandidates(workId, workById(workId).title);
      const candidate = candidates.find((item) => item.id === candidateId);
      if (!candidate) {
        throw new DemoServiceError('候选已失效，请重新检索');
      }
      if (candidate.failing) {
        throw new DemoServiceError('该候选在演示中被判定为不可确认，已保留原资料');
      }
      return setOverride(workId, {
        metadataCandidateId: candidate.id,
        metadataProvenance: 'manual',
      });
    },

    async setManualTitle(workId, title) {
      await wait(undefined, 30);
      const trimmed = title.trim();
      return setOverride(workId, { manualTitle: trimmed.length > 0 ? trimmed : undefined });
    },

    async resetManualTitle(workId) {
      await wait(undefined, 20);
      return setOverride(workId, { manualTitle: undefined });
    },

    async setManualArtwork(workId, role, artwork) {
      await wait(undefined, 30);
      return setOverride(workId, { manualArtwork: { ...artwork, role } });
    },

    async resetManualArtwork(workId) {
      await wait(undefined, 20);
      return setOverride(workId, { manualArtwork: undefined });
    },

    async bangumiSearch(query) {
      await wait(undefined, 60);
      const needle = query.trim();
      if (needle.length === 0) {
        return [];
      }
      return [0, 1, 2].map((offset) => ({
        id: `bgm-${offset + 1}-${needle.length}`,
        title: offset === 0 ? needle : `${needle} 第 ${offset + 1} 季`,
        year: 2015 + offset,
        episodes: 12 + offset * 6,
      }));
    },

    async bangumiBind(workId, subjectId) {
      await wait(undefined, 60);
      const subjects = await service.bangumiSearch(workById(workId).title);
      const subject = subjects.find((item) => item.id === subjectId);
      if (!subject) {
        throw new DemoServiceError('Bangumi 条目已失效，请重新搜索');
      }
      // 演示失败路径：条目 id 以 3 结尾时返回同步失败，保留"未匹配"以外的失败状态。
      const failing = subject.id.startsWith('bgm-3');
      return setOverride(workId, {
        bangumi: {
          subjectId: subject.id,
          title: subject.title,
          status: failing ? 'failed' : 'matched',
          lastSyncAt: new Date().toISOString(),
          syncedEpisodes: 0,
          ...(failing ? { error: '演示：账号未授权同步该条目' } : {}),
        },
      });
    },

    async bangumiUnbind(workId) {
      await wait(undefined, 20);
      return setOverride(workId, { bangumi: undefined });
    },

    async bangumiSync(workId) {
      await wait(undefined, 60);
      const binding = overrideOf(workId).bangumi;
      const work = workById(workId);
      if (!binding) {
        throw new DemoServiceError('尚未绑定 Bangumi 条目');
      }
      if (binding.status === 'failed') {
        throw new DemoServiceError(binding.error ?? 'Bangumi 同步失败');
      }
      const task = createTask({
        type: 'bangumi_sync',
        title: '同步 Bangumi 观看进度',
        sourceId: 'bangumi',
        sourceName: 'Bangumi（演示）',
        scope: 'tracking',
        durationMs: 1800,
        resultMessage: `已同步 ${work.episodeCount} 集观看进度（演示，未访问网络）`,
      });
      setOverride(workId, {
        bangumi: { ...binding, lastSyncAt: new Date().toISOString(), syncedEpisodes: work.episodeCount },
      });
      return task;
    },

    async resetDemoData() {
      // 重置前先停掉在跑的模拟任务定时器，避免重置后又被旧回调写回。
      clearTimers();
      resetDemoState();
    },
  };

  return service;
}

function sourceStatusLabel(status: SourceCard['status'], phase: SourceCard['phase']): string {
  if (status === 'scanning') {
    return phase === 'execute' ? '后台执行中' : '正在扫描';
  }
  if (phase === 'review') {
    return '待人工确认';
  }
  if (phase === 'maintenance') {
    return '需要维护';
  }
  return '空闲';
}

function episodeCodeOf(episodeId: string): string {
  const match = /s(\d{2})e(\d{2})$/i.exec(episodeId);
  return match ? `S${match[1]}E${match[2]}` : 'S01E01';
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.UTC(2026, 9, 15, 12, 0, 0) - hours * 3_600_000).toISOString();
}
