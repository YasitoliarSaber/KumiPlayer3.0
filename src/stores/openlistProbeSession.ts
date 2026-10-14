import { create } from 'zustand';

/** 只在本次应用运行中暂停自动检查；手动检查仍可使用。 */
export const useOpenListProbeSession = create<{ paused: boolean; pause: () => void }>(set => ({
  paused: false,
  pause: () => set({ paused: true }),
}));

export const automaticProbeAttempts = new Map<string, number>();
export const automaticProbeFailures = new Map<string, string>();
export const AUTOMATIC_PROBE_INTERVAL_MS = 20_000;
