/**
 * 演示模式界面偏好（来源筛选、侧栏模式、排序等）。
 * 与演示数据分开存放，键名独立，避免和业务数据混在一起被误当成媒体事实。
 */

const STORAGE_KEY = 'kumiplayer-demo-preferences-v1';

export interface DemoPreferences {
  readonly source?: string;
  readonly sidebarMode?: string;
  readonly sort?: string;
}

export function readDemoPreferences(): DemoPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as DemoPreferences) : {};
  } catch {
    return {};
  }
}

export function pushDemoPreference(patch: DemoPreferences): void {
  try {
    const current = readDemoPreferences();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...patch }));
  } catch {
    // 存储不可用时仅影响持久化。
  }
}
