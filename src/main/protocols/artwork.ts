/**
 * 受限图片协议（B 9.4）。
 *
 * 只接受“资源 ID / 内容版本 / 尺寸”身份，映射到固定回环后端的允许 GET；
 * 不接受任意 URL、path、scheme、重定向目标或请求头，也不把图片塞进 JSON/base64。
 */

import { protocol } from 'electron';

import { ARTWORK_PROTOCOL, ARTWORK_WIDTHS } from '@shared/contracts/desktop';
import { BACKEND_HOST } from '../config';

const RESOURCE_ID = /^[0-9a-f]{64}$/;
const CONTENT_VERSION = /^[0-9a-f]{64}-webp-v1$/;

export interface ArtworkProtocolOptions {
  readonly port: () => number;
  readonly token: () => string;
  readonly fetchImpl?: typeof fetch;
}

interface ArtworkIdentity {
  readonly resourceId: string;
  readonly contentVersion: string;
  readonly width: number;
}

export function parseArtworkUrl(raw: string): ArtworkIdentity | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${ARTWORK_PROTOCOL}:` || url.hostname !== 'artwork') {
    return null;
  }
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== 3) {
    return null;
  }
  const [resourceId, contentVersion, widthText] = segments;
  if (!RESOURCE_ID.test(resourceId) || !CONTENT_VERSION.test(contentVersion)) {
    return null;
  }
  const width = Number.parseInt(widthText, 10);
  if (!(ARTWORK_WIDTHS as readonly number[]).includes(width)) {
    return null;
  }
  return { resourceId, contentVersion, width };
}

export function registerArtworkProtocol(options: ArtworkProtocolOptions): void {
  const fetchImpl = options.fetchImpl ?? fetch;

  protocol.handle(ARTWORK_PROTOCOL, async (request) => {
    const identity = parseArtworkUrl(request.url);
    if (!identity) {
      return new Response('非法图片资源标识', { status: 400 });
    }
    const upstream = new URL(
      `http://${BACKEND_HOST}:${options.port()}/api/assets/artwork/` +
        `${identity.resourceId}/${identity.contentVersion}/${identity.width}`,
    );
    upstream.searchParams.set('api_token', options.token());

    const headers: Record<string, string> = { Accept: 'image/*' };
    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch) {
      headers['If-None-Match'] = ifNoneMatch;
    }

    let response: Response;
    try {
      response = await fetchImpl(upstream, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: request.signal,
      });
    } catch {
      return new Response('图片后端不可用', { status: 502 });
    }

    if (response.status === 304) {
      return new Response(null, {
        status: 304,
        headers: forwardHeaders(response, false),
      });
    }
    if (!response.ok) {
      return new Response('图片资源不可用', { status: response.status });
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) {
      return new Response('图片后端返回了非图片内容', { status: 502 });
    }
    return new Response(response.body, {
      status: 200,
      headers: forwardHeaders(response, true),
    });
  });
}

function forwardHeaders(response: Response, includeBodyMetadata: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  const etag = response.headers.get('etag');
  if (etag) {
    headers.ETag = etag;
  }
  const cacheControl = response.headers.get('cache-control');
  if (cacheControl) {
    headers['Cache-Control'] = cacheControl;
  }
  if (includeBodyMetadata) {
    const contentType = response.headers.get('content-type');
    if (contentType) {
      headers['Content-Type'] = contentType;
    }
    const length = response.headers.get('content-length');
    if (length) {
      headers['Content-Length'] = length;
    }
  }
  return headers;
}
