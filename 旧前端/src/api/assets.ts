// KumiPlayer 2.0 Assets API

import { API_BASE } from './client'
import { withApiSessionToken } from './sessionToken'

type AssetKind = 'poster' | 'backdrop' | 'detailBackdrop' | 'candidate' | 'episode' | 'logo'

export function buildAssetUrl(
  path: string | null | undefined,
  _options: { kind?: AssetKind; thumbnailWidth?: number; cacheOnly?: boolean } = {},
): string {
  if (!path) return ''
  if (/^\/api\/assets\/artwork\/[0-9a-f]{64}\/[0-9a-f]{64}-webp-v1\/(?:256|384|512|768|1280)$/.test(path)) {
    return withApiSessionToken(API_BASE + path)
  }
  // 候选与普通展示都只读已发布资源，未准备图片使用已有文字占位。
  return ''
}
