/**
 * Mantine 主题桥接。
 *
 * 语义色仍由 tokens.css 的 CSS 变量定义（复刻当前应用三套主题），
 * 这里只把同一批值映射进 Mantine 的变量与明暗方案，避免出现第二套配色。
 */

import type { CSSVariablesResolver, MantineColorsTuple } from '@mantine/core';

export type AppThemeName = 'fluent' | 'cinema' | 'mica';

/** 三套主题的强调色按浅深阶展开，供 Mantine 的主色系使用。 */
const ACCENTS: Record<AppThemeName, string> = {
  fluent: '#607da8',
  cinema: '#86a8e7',
  mica: '#586570',
};

function accentScale(hex: string): MantineColorsTuple {
  const [r, g, b] = hexToRgb(hex);
  // 0 最浅（接近白）、5 为基准色、9 最深（接近黑），只做单色相明度展开。
  const shade = (index: number): string => {
    if (index === 5) {
      return hex;
    }
    if (index < 5) {
      const ratio = ((5 - index) / 5) * 0.86;
      return toHex(lerp(r, 255, ratio), lerp(g, 255, ratio), lerp(b, 255, ratio));
    }
    const ratio = ((index - 5) / 4) * 0.62;
    return toHex(lerp(r, 0, ratio), lerp(g, 0, ratio), lerp(b, 0, ratio));
  };
  return [
    shade(0),
    shade(1),
    shade(2),
    shade(3),
    shade(4),
    shade(5),
    shade(6),
    shade(7),
    shade(8),
    shade(9),
  ];
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function lerp(from: number, to: number, ratio: number): number {
  return Math.round(from + (to - from) * ratio);
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export function createAppTheme(themeName: AppThemeName) {
  return {
    primaryColor: 'kumi',
    primaryShade: themeName === 'cinema' ? (5 as const) : (6 as const),
    colors: { kumi: accentScale(ACCENTS[themeName]) },
    fontFamily: 'var(--font-sans)',
    defaultRadius: 'md' as const,
    respectReducedMotion: true,
  };
}

export function colorSchemeFor(themeName: AppThemeName): 'light' | 'dark' {
  return themeName === 'cinema' ? 'dark' : 'light';
}

/** 把语义变量交给 Mantine，避免组件库自带配色与产品配色分叉。 */
export const kumiCssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    '--mantine-color-body': 'var(--surface-solid)',
    '--mantine-color-text': 'var(--text)',
    '--mantine-color-dimmed': 'var(--text-muted)',
    '--mantine-color-default-border': 'var(--border)',
    '--mantine-color-default': 'var(--surface-soft)',
    '--mantine-color-default-hover': 'var(--surface-hover)',
    '--mantine-color-default-color': 'var(--text)',
  },
  dark: {
    '--mantine-color-body': 'var(--surface-solid)',
    '--mantine-color-text': 'var(--text)',
    '--mantine-color-dimmed': 'var(--text-muted)',
    '--mantine-color-default-border': 'var(--border)',
    '--mantine-color-default': 'var(--surface-soft)',
    '--mantine-color-default-hover': 'var(--surface-hover)',
    '--mantine-color-default-color': 'var(--text)',
  },
});

export function applyThemeToDocument(themeName: AppThemeName): void {
  if (typeof document === 'undefined') {
    return;
  }
  document.documentElement.dataset.theme = themeName;
}
