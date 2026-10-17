/**
 * 主题偏好 → 文档 data-theme。
 *
 * 语义变量定义在 styles/tailwind.css；这里只把用户偏好（含 system）
 * 解析成具体主题名写到 <html data-theme>，不依赖任何组件库运行时。
 */

export type AppThemeName = 'mica' | 'cinema';
export type ThemePreference = AppThemeName | 'system';
export type MaterialName = 'solid' | 'mica' | 'acrylic' | 'liquid';
export type FontPreset = 'system' | 'modern' | 'wenkai';

/** 只保留原型冻结的两个主题：纯白（mica）与深色（cinema）。 */
export const THEME_LABELS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'mica', label: '纯白' },
  { value: 'cinema', label: '深色' },
];

export const MATERIAL_LABELS: ReadonlyArray<{ value: MaterialName; label: string }> = [
  { value: 'solid', label: '纯色' },
  { value: 'mica', label: '云母' },
  { value: 'acrylic', label: '亚克力' },
  { value: 'liquid', label: '液态玻璃' },
];

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): AppThemeName {
  // `system` 是既有配置的合法取值：浅色 → 纯白，深色 → cinema。
  if (preference === 'system') {
    return prefersDark ? 'cinema' : 'mica';
  }
  // 历史配置里的 `fluent` 归一到纯白，不恢复蓝色主题。
  return preference === 'cinema' ? 'cinema' : 'mica';
}

export function applyMaterialToDocument(material: MaterialName): void {
  if (typeof document === 'undefined') {
    return;
  }
  if (document.documentElement.dataset.material !== material) {
    document.documentElement.dataset.material = material;
  }
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
