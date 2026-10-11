import { invoke, isTauri } from '@tauri-apps/api/core';

export interface WindowPreferences {
  minimize_to_tray: boolean;
  close_to_tray: boolean;
}

function requireDesktop() {
  if (!isTauri()) throw new Error('窗口与托盘设置仅在桌面应用中可用');
}

export async function getWindowPreferences(): Promise<WindowPreferences> {
  requireDesktop();
  return invoke<WindowPreferences>('get_window_preferences');
}

export async function saveWindowPreferences(preferences: WindowPreferences): Promise<WindowPreferences> {
  requireDesktop();
  return invoke<WindowPreferences>('set_window_preferences', { preferences });
}

export async function hideToTray(): Promise<void> {
  requireDesktop();
  await invoke('hide_to_tray');
}
