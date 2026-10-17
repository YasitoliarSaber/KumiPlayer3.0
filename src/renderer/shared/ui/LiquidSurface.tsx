import { useEffect, useRef, useState } from 'react';
import type { LiquidGlassEngine } from 'quick-liquid/core';
import { useDemoState } from '@/mock/demo-store';
import styles from './LiquidSurface.module.css';

/** 仅作装饰的有界表面。控件仍由 Radix/shadcn 管理，不复制内容或接管事件。 */
export function LiquidSurface() {
  const { material, theme } = useDemoState().settings.appearance;
  const ref = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    if (material !== 'liquid' || !ref.current) return;
    const transparency = matchMedia('(prefers-reduced-transparency: reduce)');
    const contrast = matchMedia('(forced-colors: active)');
    let cancelled = false;
    let generation = 0;
    let engine: LiquidGlassEngine | undefined;
    const sync = async () => {
      const current = ++generation;
      engine?.destroy();
      engine = undefined;
      setReady(false);
      if (transparency.matches || contrast.matches || !ref.current) return;
      try {
        const { LiquidGlassEngine: Engine } = await import('quick-liquid/core');
        if (cancelled || generation !== current || !ref.current) return;
        engine = new Engine(ref.current, {
          quality: 'low', refractionMode: 'auto', blur: 1.5, saturation: 1.05,
          chromaticAberration: 0, refractionStrength: 10, bezelWidth: 12,
          borderRadius: 8, tint: theme === 'cinema' ? '13, 17, 23' : '255, 255, 255',
          tintOpacity: .32, appearance: theme === 'cinema' ? 'dark' : 'light',
          cursorTracking: false, hoverLighting: false, parallax: false,
          inertia: false, dynamicLighting: false, noiseOpacity: 0,
          specularStrength: .25, edgeHighlight: .35, respectPreferences: true,
        });
        setReady(true);
      } catch {
        // 不支持 SVG 折射或加载失败时保留 CSS 玻璃，不阻断搜索等实际功能。
        setReady(false);
      }
    };
    void sync();
    transparency.addEventListener('change', sync);
    contrast.addEventListener('change', sync);
    return () => {
      cancelled = true;
      generation += 1;
      engine?.destroy();
      transparency.removeEventListener('change', sync);
      contrast.removeEventListener('change', sync);
    };
  }, [material, theme]);
  return material === 'liquid' ? <span ref={ref} className={styles.surface} data-liquid-ready={ready} aria-hidden="true" /> : null;
}
