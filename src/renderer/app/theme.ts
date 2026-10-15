/**
 * 主题偏好 → 文档 data-theme。
 *
 * 语义变量定义在 styles/tailwind.css；这里只把用户偏好（含 system）
 * 解析成具体主题名写到 <html data-theme>，不依赖任何组件库运行时。
 */

export type AppThemeName = 'fluent' | 'cinema' | 'mica';
export type ThemePreference = AppThemeName | 'system';

export const THEME_LABELS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'fluent', label: '浅色' },
  { value: 'cinema', label: '深色' },
  { value: 'mica', label: '纯白' },
];

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): AppThemeName {
  if (preference === 'system') {
    return prefersDark ? 'cinema' : 'fluent';
  }
  return preference;
}

export function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

export function applyThemeToDocument(themeName: AppThemeName): void {
  if (typeof document === 'undefined') {
    return;
  }
  if (document.documentElement.dataset.theme !== themeName) {
    document.documentElement.dataset.theme = themeName;
  }
}
