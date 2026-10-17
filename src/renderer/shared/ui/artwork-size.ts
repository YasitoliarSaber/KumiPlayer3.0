import type { ArtworkRef } from '@/shared/api/service';

/** 只在服务层已经校验的变体中选图；保留内容版本，不拼接原图地址。 */
export function artworkAtWidth(artwork: ArtworkRef | null, cssWidth: number, dpr = 1): ArtworkRef | null {
  if (!artwork?.variants?.length || !(cssWidth > 0)) return artwork;
  const target = cssWidth * (Number.isFinite(dpr) && dpr > 0 ? dpr : 1);
  const variants = artwork.variants;
  const selected = variants.find((entry) => entry.width >= target) ?? variants[variants.length - 1]!;
  return { ...artwork, url: selected.url, width: selected.width, height: 0 };
}
