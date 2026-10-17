/**
 * 图片读取组件：消费服务层给出的图片引用，失败时提供稳定回退。
 */

import { useEffect, useState } from 'react';

import type { ArtworkRef } from '../api/service';
import { cn } from '@/shared/lib/utils';

export type ArtworkKind = 'poster' | 'fanart' | 'logo' | 'episode';

interface ArtworkProps {
  readonly artwork: ArtworkRef | null;
  readonly alt: string;
  readonly kind?: ArtworkKind;
  readonly fallbackLabel?: string;
  readonly className?: string;
  readonly loading?: 'lazy' | 'eager';
  readonly onError?: () => void;
}

export function Artwork({
  artwork,
  alt,
  kind = 'poster',
  fallbackLabel = '暂无图片',
  className,
  loading = 'lazy',
  onError,
}: ArtworkProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [artwork?.url]);

  if (!artwork || failed) {
    return (
      <span className={cn('grid place-items-center overflow-hidden bg-muted px-3 text-center text-[12px] text-muted-foreground', className)} data-artwork-fallback={kind} aria-hidden="true">
        {fallbackLabel}
      </span>
    );
  }
  return (
    <img
      className={className}
      src={artwork.url}
      alt={alt}
      width={artwork.width || undefined}
      height={artwork.height || undefined}
      loading={loading}
      decoding="async"
      draggable={false}
      onError={() => { setFailed(true); onError?.(); }}
    />
  );
}
