/**
 * 轻量 UI 状态：来源筛选、侧栏模式与本地界面偏好。
 * 只保存界面选择，不保存媒体事实；筛选/排序由路由表达的部分留在路由里。
 */

import { create } from 'zustand';

import type { SourceId } from '../shared/api/service';
import { pushDemoPreference } from '../mock/preferences';

export type SidebarMode = 'expanded' | 'collapsed' | 'hidden';
export type SourceFilter = 'all' | SourceId;

interface UiState {
  readonly source: SourceFilter;
  readonly sidebarMode: SidebarMode;
  setSource: (source: SourceFilter) => void;
  toggleSidebar: () => void;
  toggleSidebarVisibility: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  source: 'all',
  sidebarMode: 'expanded',
  setSource: (source) => {
    pushDemoPreference({ source });
    set({ source });
  },
  toggleSidebar: () =>
    set((state) => ({
      sidebarMode: state.sidebarMode === 'expanded' ? 'collapsed' : 'expanded',
    })),
  toggleSidebarVisibility: () =>
    set((state) => ({ sidebarMode: state.sidebarMode === 'hidden' ? 'expanded' : 'hidden' })),
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
