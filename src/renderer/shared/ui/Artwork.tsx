/**
 * 图片读取组件：按显示宽度消费已发布变体，缺图与失败保留透明区域。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { ArtworkRef } from '../api/service';
import { artworkAtWidth } from './artwork-size';
import { artworkLifecycle, type ArtworkPriority } from './artwork-lifecycle';
import { devicePixelRatio, watchArtwork, watchArtworkSize, watchDevicePixelRatio } from './artwork-observers';

export type ArtworkKind = 'poster' | 'fanart' | 'logo' | 'episode';

interface ArtworkProps {
  readonly artwork: ArtworkRef | null;
  readonly alt: string;
  readonly kind?: ArtworkKind;
  readonly fallbackLabel?: string;
  readonly className?: string;
  readonly loading?: 'lazy' | 'eager';
  readonly onError?: () => void;
  readonly displayWidth?: number;
  readonly priority?: ArtworkPriority | null;
}

export function Artwork({
  artwork,
  alt,
  kind = 'poster',
  className,
  loading = 'lazy',
  onError,
  displayWidth,
  priority,
}: ArtworkProps) {
  const element = useRef<HTMLImageElement | HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  const [observed, setObserved] = useState<ArtworkPriority | null>(null);
  const dpr = useSyncExternalStore(watchDevicePixelRatio, devicePixelRatio);
  const measuredWidth = displayWidth ?? width;
  const selected = artworkAtWidth(artwork, measuredWidth, dpr);
  const url = selected?.url ?? '';
  const subscribe = useCallback((listener: () => void) => artworkLifecycle.subscribe(url, listener), [url]);
  const snapshot = useCallback(() => artworkLifecycle.state(url), [url]);
  const state = useSyncExternalStore(subscribe, snapshot);
  const failed = state === 'failed';
  const loadPriority = priority !== undefined ? priority : loading === 'eager' ? 'visible' : observed;
  const errorHandler = useRef(onError);
  errorHandler.current = onError;

  useLayoutEffect(() => {
    const node = element.current;
    if (!node || displayWidth !== undefined || !artwork?.variants?.length) return;
    return watchArtworkSize(node, setWidth);
  }, [displayWidth, artwork?.variants, failed]);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || priority !== undefined || loading === 'eager') return;
    return watchArtwork(node, setObserved);
  }, [priority, loading, failed]);
  useEffect(() => {
    if (!url || !loadPriority || (artwork?.variants?.length && measuredWidth <= 0)) return;
    return artworkLifecycle.request(url, loadPriority);
  }, [url, loadPriority, measuredWidth, artwork?.variants?.length]);
  useEffect(() => {
    if (state !== 'failed' || !loadPriority) return;
    errorHandler.current?.();
    const retryAt = artworkLifecycle.retryAt(url);
    if (retryAt === null) return;
    let release: (() => void) | undefined;
    const timer = setTimeout(() => { release = artworkLifecycle.request(url, loadPriority); }, Math.max(0, retryAt - Date.now()));
    return () => { clearTimeout(timer); release?.(); };
  }, [state, url, loadPriority]);

  if (!selected || failed) return <span ref={element} className={className} data-artwork-fallback={kind} aria-hidden="true" />;
  const granted = state === 'loading' || state === 'ready';
  return (
    <img
      ref={element as React.Ref<HTMLImageElement>}
      className={className}
      src={granted ? url : undefined}
      style={granted ? undefined : { visibility: 'hidden' }}
      alt={alt}
      width={selected.width || undefined}
      height={selected.height || undefined}
      loading="eager"
      data-artwork-state={state}
      data-artwork-priority={loadPriority ?? 'resident'}
      decoding="async"
      draggable={false}
      onError={() => artworkLifecycle.reportFailure(url)}
    />
  );
}
