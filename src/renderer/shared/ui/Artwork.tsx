/**
 * 图片读取组件：只接受演示素材 URL，失败时给出稳定回退，不访问外部网络。
 */

import { useEffect, useState } from 'react';

import type { ArtworkRef } from '../api/service';

export type ArtworkKind = 'poster' | 'fanart' | 'logo' | 'episode';

interface ArtworkProps {
  readonly artwork: ArtworkRef | null;
  readonly alt: string;
  readonly kind?: ArtworkKind;
  readonly fallbackLabel?: string;
  readonly className?: string;
  readonly loading?: 'lazy' | 'eager';
}

export function Artwork({
  artwork,
  alt,
  kind = 'poster',
  fallbackLabel = '暂无图片',
  className,
  loading = 'lazy',
}: ArtworkProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [artwork?.url]);

  if (!artwork || failed) {
    return (
      <span className={className} data-artwork-fallback={kind} aria-hidden="true">
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
      onError={() => setFailed(true)}
    />
  );
}
