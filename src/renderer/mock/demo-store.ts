/**
 * 演示数据存储。
 *
 * 只保存演示交互产生的本机状态（收藏、观看状态、模拟进度、演示设置、
 * 演示场景开关），使用独立命名的 `kumiplayer-demo-v1` 键，
 * 不读取、不写入任何真实用户配置或业务数据。
 *
 * 任务与播放会话是会话内状态，不落盘：重启演示应用不会留下"正在运行"的假任务。
 */

import { useSyncExternalStore } from 'react';

import type {
  PlaybackSession,
  ProgressSnapshot,
  SettingsSnapshot,
  SourceCard,
  TaskEntry,
  WatchStatus,
  WorkOverride,
} from '../shared/api/service';

const STORAGE_KEY = 'kumiplayer-demo-v1';

export type DemoScenario = 'default' | 'empty' | 'loading' | 'error';

export interface PersistedDemoState {
  readonly favorite: Readonly<Record<string, boolean>>;
  readonly watch: Readonly<Record<string, WatchStatus>>;
  readonly progress: Readonly<Record<string, ProgressSnapshot>>;
  readonly settings: SettingsSnapshot;
  readonly scenario: DemoScenario;
  readonly sourceOverrides: Readonly<Record<string, Partial<SourceCard>>>;
  /** 用户手动覆盖：标题、图片、线上候选与 Bangumi 绑定（演示内存 + 本机存储）。 */
  readonly overrides: Readonly<Record<string, WorkOverride>>;
}

export interface DemoState extends PersistedDemoState {
  readonly tasks: readonly TaskEntry[];
  readonly playback: PlaybackSession | null;
}

export const DEFAULT_SETTINGS: SettingsSnapshot = {
  application: {
    minimizeToTray: false,
    closeToTray: false,
    connectionMonitor: true,
    setupCompleted: false,
    setupDeferred: false,
  },
  appearance: {
    theme: 'fluent',
    motion: 'standard',
    posterSize: 8,
    cardImageMode: 'poster',
  },
  sources: {
    localRoots: [
      { id: 'local-anime', path: 'D:\\Media\\Anime', name: '本地动画库' },
      { id: 'local-movie', path: 'D:\\Media\\Movie', name: '本地电影库' },
    ],
    ongoingOnStartup: false,
    ongoingIntervalMinutes: 0,
  },
  openlist: {
    connections: [
      {
        id: 'conn-115',
        name: '115 主账号',
        serverUrl: 'http://127.0.0.1:5244',
        remoteRoot: '/115',
        mountRoot: 'Z:\\115',
        configured: true,
      },
      {
        id: 'conn-quark',
        name: '夸克备用',
        serverUrl: '',
        remoteRoot: '',
        mountRoot: '',
        configured: false,
      },
    ],
    routes: [
      { id: 'route-1', label: '115 动画路由', remote: '/115/anime', local: 'Z:\\115\\anime' },
      { id: 'route-2', label: '夸克剧场版路由', remote: '/quark/movie', local: 'Y:\\quark\\movie' },
    ],
  },
  scrape: {
    tmdbLanguage: 'zh-CN',
    tmdbConfigured: true,
    anilistEnabled: true,
    imageStorageMode: 'auto',
  },
  player: {
    mode: 'internal',
    externalPath: '',
    autoPlayNext: true,
    anime4kMode: 'off',
    anime4kQuality: 'balanced',
  },
  bangumi: {
    configured: false,
    username: '',
    nickname: '',
    syncEnabled: false,
  },
};

const EMPTY_STATE: DemoState = {
  favorite: {},
  watch: {},
  progress: {},
  settings: DEFAULT_SETTINGS,
  scenario: 'default',
  sourceOverrides: {},
  overrides: {},
  tasks: [],
  playback: null,
};

let state: DemoState = load();
const listeners = new Set<() => void>();

function load(): DemoState {
  const storage = safeStorage();
  if (!storage) {
    return { ...EMPTY_STATE };
  }
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...EMPTY_STATE };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedDemoState>;
    return {
      ...EMPTY_STATE,
      ...parsed,
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
      tasks: [],
      playback: null,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function persist(): void {
  const storage = safeStorage();
  if (!storage) {
    return;
  }
  const payload: PersistedDemoState = {
    favorite: state.favorite,
    watch: state.watch,
    progress: state.progress,
    settings: state.settings,
    scenario: state.scenario,
    sourceOverrides: state.sourceOverrides,
    overrides: state.overrides,
  };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 存储不可用时只影响持久化，不影响本次演示。
  }
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getDemoState(): DemoState {
  return state;
}

export function updateDemoState(patch: (current: DemoState) => Partial<DemoState>): void {
  state = { ...state, ...patch(state) };
  persist();
  emit();
}

export function subscribeDemoState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React 订阅入口：所有演示页面共用同一份状态。 */
export function useDemoState(): DemoState {
  return useSyncExternalStore(subscribeDemoState, getDemoState, getDemoState);
}

export function resetDemoState(): void {
  const storage = safeStorage();
  storage?.removeItem(STORAGE_KEY);
  state = { ...EMPTY_STATE };
  emit();
}

export function upsertTask(task: TaskEntry): void {
  updateDemoState((current) => ({
    tasks: [task, ...current.tasks.filter((entry) => entry.id !== task.id)].slice(0, 60),
  }));
}

export function setPlayback(playback: PlaybackSession | null): void {
  updateDemoState(() => ({ playback }));
}
