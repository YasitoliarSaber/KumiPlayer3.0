/**
 * 临时跨页 UI 状态（Zustand）。只放桌面连接状态与轻量 UI 偏好，
 * 不存完整媒体响应、任务真相或观看持久数据。
 */

import { create } from 'zustand';

import type { DesktopStatus } from '@shared/contracts/desktop';

export interface DesktopState {
  readonly status: DesktopStatus | null;
  setStatus: (status: DesktopStatus) => void;
}

export const useDesktopStore = create<DesktopState>((set) => ({
  status: null,
  setStatus: (status) => set({ status }),
}));
