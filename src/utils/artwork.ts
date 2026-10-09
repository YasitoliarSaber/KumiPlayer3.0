export type ArtworkKind = 'poster' | 'fanart' | 'clearlogo';

type ArtworkOwner = { artwork?: Partial<Record<ArtworkKind, { state: string; variants: Record<string, string> }>> } & Partial<Record<
  'poster_path' | 'fanart_path' | 'clearlogo_path'
  | 'local_poster_path' | 'local_fanart_path' | 'local_clearlogo_path',
  string | null | undefined
>>;

/**
 * 普通展示只消费后台已发布的资源版本与尺寸，不回退原图或远程地址。
 */
export function preferredArtworkPath(owner: ArtworkOwner, kind: ArtworkKind, cssWidth?: number): string {
  const resource = owner.artwork?.[kind];
  if (resource?.state === 'ready') {
    const widths = Object.keys(resource.variants).map(Number).filter((width) => width > 0).sort((a, b) => a - b);
    const target = cssWidth || (kind === 'fanart' ? 1280 : kind === 'clearlogo' ? 512 : 384);
    const selected = widths.find((width) => width >= target) || widths.at(-1);
    return selected ? resource.variants[String(selected)] || '' : '';
  }
  // 旧路径只接受后台已发布的资源 URL，浏览请求不回退原图或远程下载。
  const path = owner[`local_${kind}_path`] || owner[`${kind}_path`] || '';
  return /^\/api\/assets\/artwork\//.test(path) ? path : '';
}
