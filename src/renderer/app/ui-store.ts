/**
 * 轻量 UI 状态：来源筛选、侧栏模式与本地界面偏好。
 * 只保存界面选择，不保存媒体事实；筛选/排序由路由表达的部分留在路由里。
 */

import { create } from 'zustand';

import type { SourceId } from '../shared/api/service';
import { pushDemoPreference } from '../mock/preferences';

export type SidebarMode = 'expanded' | 'collapsed' | 'hidden';
export type SourceFilter = 'all' | SourceId;
export type StartPage = 'home' | 'library' | 'recent' | 'favorites';

interface UiState {
  readonly source: SourceFilter;
  readonly sidebarMode: SidebarMode;
  /** 海报墙列数（6–9）：页面内会话偏好，与设置里的持久值分开。 */
  readonly posterColumns: number;
  /** 默认显示界面与默认侧栏状态：本机 UI 偏好，不写后端配置。 */
  readonly startPage: StartPage;
  readonly sidebarDefault: SidebarMode;
  /** 首次引导：可从设置重新打开，取消不清空演示设置。 */
  readonly setupOpen: boolean;
  setSource: (source: SourceFilter) => void;
  setPosterColumns: (columns: number) => void;
  setStartPage: (page: StartPage) => void;
  setSidebarDefault: (mode: SidebarMode) => void;
  toggleSidebar: () => void;
  toggleSidebarVisibility: () => void;
  openSetup: () => void;
  closeSetup: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  source: 'all',
  sidebarMode: 'expanded',
  posterColumns: 6,
  startPage: 'home',
  sidebarDefault: 'expanded',
  setupOpen: false,
  setSource: (source) => {
    pushDemoPreference({ source });
    set({ source });
  },
  setPosterColumns: (columns) =>
    set({ posterColumns: Math.min(9, Math.max(6, Math.round(columns))) }),
  setStartPage: (page) => set({ startPage: page }),
  setSidebarDefault: (mode) => set({ sidebarMode: mode, sidebarDefault: mode }),
  toggleSidebar: () =>
    set((state) => ({
      sidebarMode: state.sidebarMode === 'expanded' ? 'collapsed' : 'expanded',
    })),
  toggleSidebarVisibility: () =>
    set((state) => ({ sidebarMode: state.sidebarMode === 'hidden' ? 'expanded' : 'hidden' })),
  openSetup: () => set({ setupOpen: true }),
  closeSetup: () => set({ setupOpen: false }),
}));

export const SOURCE_LABELS: ReadonlyArray<{ value: SourceFilter; label: string }> = [
  { value: 'all', label: '全部来源' },
  { value: 'local', label: '本地' },
  { value: 'pan115', label: '115 网盘' },
  { value: 'baidu', label: '百度网盘' },
  { value: 'quark', label: '夸克网盘' },
  { value: 'openlist', label: 'OpenList' },
  { value: 'hybrid', label: '混合来源' },
];
